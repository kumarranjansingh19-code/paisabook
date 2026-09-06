import type { View } from '../app/router';
import { html, raw, money, onAction, catLabel, pct } from '../app/ui';
import { db } from '../store/db';
import { availableMonths, inMonth, monthlyCashflow, settlement, spendByAccount, spendByCategory, topMerchants, upcomingBills } from '../core/analytics';
import { addMonths, monthLabel, monthOf, todayIso } from '../core/dates';
import { loadPendingFromSheet, syncState } from '../core/sync';
import { unmatchedHints } from '../core/accounts';

let month = monthOf(todayIso());

export const dashboardView: View = {
  title: 'Home',
  render(root, params) {
    if (params.get('m')) month = params.get('m')!;
    const draw = () => {
      root.innerHTML = page();
    };
    draw();
    onAction(root, {
      prev: () => {
        month = addMonths(month, -1);
        draw();
      },
      next: () => {
        month = addMonths(month, 1);
        draw();
      },
      cat: (el) => {
        location.hash = `#/txns?m=${month}&cat=${encodeURIComponent(el.dataset.cat!)}`;
      },
      acc: (el) => {
        location.hash = `#/txns?m=${month}&acc=${encodeURIComponent(el.dataset.acc!)}`;
      },
    });
    return db.onChange(draw);
  },
};

function page(): string {
  loadPendingFromSheet();
  const live = db.liveTransactions().filter((t) => t.status !== 'unmatched');
  if (!live.length) return empty();
  const rows = inMonth(live, month);
  const cats = spendByCategory(rows);
  const spend = cats.reduce((s, c) => s + c.total_paise, 0);
  const flow = monthlyCashflow(live);
  const thisFlow = flow.find((f) => f.month === month);
  const prevFlow = flow.find((f) => f.month === addMonths(month, -1));
  const settle = settlement(month);
  const bills = upcomingBills().filter((b) => b.due_date >= todayIso());
  const unmatched = unmatchedHints();
  const review = live.filter((t) => t.status === 'needs_review').length;
  const months = availableMonths(live);
  const maxCat = cats[0]?.total_paise ?? 1;
  const merchants = topMerchants(rows);
  const byAcc = spendByAccount(rows);

  return html`
    <div class="month-nav">
      <button class="btn small" data-action="prev">‹</button>
      <h2>${monthLabel(month)}</h2>
      <button class="btn small" data-action="next" ${month >= monthOf(todayIso()) ? 'disabled' : ''}>›</button>
    </div>
    ${!months.includes(month) ? raw('<p class="muted center small">No transactions in this month yet.</p>') : ''}
    <div class="grid">
      <div class="stat"><div class="label">Real spend</div><div class="value">${money(spend, true)}</div>
        <div class="sub">${settle.settled ? raw('<span class="pill ok">✓ settled</span>') : raw(`<span class="pill warn" title="${settle.awaiting.map(escape).join(', ')}">⏳ ${settle.awaiting.length} pending</span>`)}
        ${prevFlow ? raw(`<span class="muted"> · ${delta(spend, prevFlow.spent_paise)} vs last month</span>`) : ''}</div></div>
      <div class="stat"><div class="label">Income</div><div class="value">${money(thisFlow?.income_paise ?? 0, true)}</div><div class="sub">${thisFlow?.salary_paise ? `salary ${money(thisFlow.salary_paise, true)}` : 'into bank accounts'}</div></div>
      <div class="stat"><div class="label">Invested</div><div class="value">${money(thisFlow?.invested_paise ?? 0, true)}</div><div class="sub">family ${money(thisFlow?.family_paise ?? 0, true)}</div></div>
      <div class="stat ${(thisFlow?.net_paise ?? 0) >= 0 ? 'good' : 'bad'}"><div class="label">Net</div><div class="value">${money(thisFlow?.net_paise ?? 0, true)}</div><div class="sub">cash ${money(thisFlow?.cash_net_paise ?? 0, true)} · card bills ${money(thisFlow?.cc_payment_paise ?? 0, true)}</div></div>
    </div>

    ${!settle.settled
      ? raw(`<div class="card small" style="background:var(--md-surface-container-low);box-shadow:none"><strong>Why ${escape(monthLabel(month))} isn't settled yet:</strong> a card's spends for a month are confirmed by the statement whose period ends on or after the last day of that month — usually the one generated the following month.
          Still to import for: ${settle.awaiting.map(escape).join(', ')}. ${syncState.pendingPdfs.length ? `<a href="#/sync">${syncState.pendingPdfs.length} statement PDF${syncState.pendingPdfs.length > 1 ? 's are' : ' is'} waiting for a password</a>.` : `Run a <a href="#/sync">sync</a> over the following month so those statement emails are picked up.`}</div>`)
      : ''}
    ${review || unmatched.length || syncState.pendingPdfs.length
      ? raw(`<div class="card warn small">
          ${review ? `<div>⚠ <a href="#/txns?status=needs_review">${review} alerts</a> weren't found on a statement — confirm or mark duplicate.</div>` : ''}
          ${unmatched.length ? `<div>❓ <a href="#/accounts">${unmatched.reduce((s, u) => s + u.count, 0)} alerts</a> mention accounts you haven't added (${unmatched.slice(0, 3).map((u) => escape(u.hint)).join(', ')}).</div>` : ''}
          ${syncState.pendingPdfs.length ? `<div>🔒 <a href="#/sync">${syncState.pendingPdfs.length} statement PDFs</a> are waiting for a password or an account.</div>` : ''}
        </div>`)
      : ''}

    ${bills.length
      ? raw(`<div class="card"><h3>Card bills due</h3>${bills.map((b) => `<div class="list-item"><div class="grow"><div class="title">${escape(b.account)}</div><div class="sub">due ${b.due_date}</div></div><div class="nowrap"><strong>${money(b.total_due_paise)}</strong></div></div>`).join('')}</div>`)
      : ''}

    <div class="card">
      <div class="row between"><h3>Where it went</h3><a class="small" href="#/txns?m=${month}">all transactions →</a></div>
      ${cats.length
        ? raw(`<div class="bars">${cats
            .map(
              (c) => `<div class="bar-row clickable" data-action="cat" data-cat="${escape(c.category)}">
                <span>${escape(catLabel(c.category))} <span class="muted small">· ${c.txn_count}</span></span>
                <span class="num">${money(c.total_paise, true)}<span class="muted small">${pct(c.total_paise, spend)}%</span></span>
                <div class="track"><div class="fill" style="width:${pct(Math.max(c.total_paise, 0), maxCat)}%"></div></div></div>`,
            )
            .join('')}</div>`)
        : raw('<p class="muted">Nothing yet.</p>')}
    </div>

    <div class="grid cards">
      <div class="card"><h3>Top merchants</h3>${merchants.length ? raw(merchants.map((m) => `<div class="list-item"><div class="grow"><div class="title">${escape(m.merchant)}</div><div class="sub">${m.txn_count}×</div></div><div class="nowrap">${money(m.total_paise, true)}</div></div>`).join('')) : raw('<p class="muted">—</p>')}</div>
      <div class="card"><h3>By account</h3>${byAcc.length ? raw(byAcc.map((a) => `<div class="list-item clickable" data-action="acc" data-acc="${a.account_id}"><div class="grow"><div class="title">${escape(db.accounts.get(a.account_id)?.display_name ?? '?')}</div><div class="sub">${a.txn_count}×</div></div><div class="nowrap">${money(a.total_paise, true)}</div></div>`).join('')) : raw('<p class="muted">—</p>')}</div>
    </div>

    <div class="card">
      <h3>Month by month</h3>
      <div class="table-wrap"><table>
        <thead><tr><th>Month</th><th class="num">Income</th><th class="num">Spend</th><th class="num">Invested</th><th class="num">Family</th><th class="num">Net</th><th class="num">Cash net</th></tr></thead>
        <tbody>${raw(
          flow
            .slice(0, 12)
            .map(
              (f) => `<tr class="clickable" onclick="location.hash='#/?m=${f.month}'"><td>${monthLabel(f.month)}${settlement(f.month).settled ? '' : ' <span class="pill warn">⏳</span>'}</td>
                <td class="num">${money(f.income_paise, true)}</td><td class="num">${money(f.spent_paise, true)}</td><td class="num">${money(f.invested_paise, true)}</td><td class="num">${money(f.family_paise, true)}</td>
                <td class="num ${f.net_paise >= 0 ? 'credit' : ''}">${money(f.net_paise, true)}</td><td class="num">${money(f.cash_net_paise, true)}</td></tr>`,
            )
            .join(''),
        )}</tbody></table></div>
    </div>`;
}

function delta(now: number, prev: number): string {
  if (!prev) return '';
  const d = pct(now - prev, prev);
  return `${d > 0 ? '▲' : '▼'} ${Math.abs(d)}%`;
}

function escape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function empty(): string {
  return `<div class="card center">
    <h2>No transactions yet</h2>
    <p class="muted">Run a sync to pull the last three months from Gmail, or import a statement PDF.</p>
    <a class="btn primary" href="#/sync">Go to Sync →</a>
  </div>`;
}

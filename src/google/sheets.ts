import { gfetch } from './auth';

const BASE = 'https://sheets.googleapis.com/v4/spreadsheets';

export type Cell = string | number | boolean | null;

export interface SheetInfo {
  spreadsheetId: string;
  title: string;
  sheets: Array<{ sheetId: number; title: string; rowCount: number }>;
}

export async function getSpreadsheet(id: string): Promise<SheetInfo> {
  const r = await gfetch<{ spreadsheetId: string; properties: { title: string }; sheets: Array<{ properties: { sheetId: number; title: string; gridProperties: { rowCount: number } } }> }>(
    `${BASE}/${id}?fields=spreadsheetId,properties.title,sheets.properties(sheetId,title,gridProperties.rowCount)`,
  );
  return {
    spreadsheetId: r.spreadsheetId,
    title: r.properties.title,
    sheets: r.sheets.map((s) => ({ sheetId: s.properties.sheetId, title: s.properties.title, rowCount: s.properties.gridProperties.rowCount })),
  };
}

export async function createSpreadsheet(title: string, tabs: string[]): Promise<SheetInfo> {
  const r = await gfetch<{ spreadsheetId: string; properties: { title: string }; sheets: Array<{ properties: { sheetId: number; title: string; gridProperties: { rowCount: number } } }> }>(
    BASE,
    { method: 'POST', body: JSON.stringify({ properties: { title }, sheets: tabs.map((t) => ({ properties: { title: t } })) }) },
  );
  return {
    spreadsheetId: r.spreadsheetId,
    title: r.properties.title,
    sheets: r.sheets.map((s) => ({ sheetId: s.properties.sheetId, title: s.properties.title, rowCount: s.properties.gridProperties.rowCount })),
  };
}

export async function addTabs(id: string, tabs: string[]): Promise<void> {
  if (!tabs.length) return;
  await gfetch(`${BASE}/${id}:batchUpdate`, {
    method: 'POST',
    body: JSON.stringify({ requests: tabs.map((t) => ({ addSheet: { properties: { title: t } } })) }),
  });
}

export async function readRange(id: string, range: string): Promise<Cell[][]> {
  const r = await gfetch<{ values?: Cell[][] }>(
    `${BASE}/${id}/values/${encodeURIComponent(range)}?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING`,
  );
  return r.values ?? [];
}

export async function batchRead(id: string, ranges: string[]): Promise<Record<string, Cell[][]>> {
  const params = new URLSearchParams({ valueRenderOption: 'UNFORMATTED_VALUE', dateTimeRenderOption: 'FORMATTED_STRING' });
  for (const r of ranges) params.append('ranges', r);
  const res = await gfetch<{ valueRanges?: Array<{ range: string; values?: Cell[][] }> }>(`${BASE}/${id}/values:batchGet?${params}`);
  const out: Record<string, Cell[][]> = {};
  (res.valueRanges ?? []).forEach((vr, i) => {
    out[ranges[i]!] = vr.values ?? [];
  });
  return out;
}

export async function appendRows(id: string, tab: string, rows: Cell[][]): Promise<void> {
  if (!rows.length) return;
  await gfetch(
    `${BASE}/${id}/values/${encodeURIComponent(`${tab}!A1`)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    { method: 'POST', body: JSON.stringify({ values: rows }) },
  );
}

export async function writeRange(id: string, range: string, rows: Cell[][]): Promise<void> {
  await gfetch(`${BASE}/${id}/values/${encodeURIComponent(range)}?valueInputOption=RAW`, {
    method: 'PUT',
    body: JSON.stringify({ values: rows }),
  });
}

export async function batchWrite(id: string, data: Array<{ range: string; values: Cell[][] }>): Promise<void> {
  if (!data.length) return;
  await gfetch(`${BASE}/${id}/values:batchUpdate`, {
    method: 'POST',
    body: JSON.stringify({ valueInputOption: 'RAW', data }),
  });
}

export async function clearRange(id: string, range: string): Promise<void> {
  await gfetch(`${BASE}/${id}/values/${encodeURIComponent(range)}:clear`, { method: 'POST', body: '{}' });
}

/** Freeze the header row and bold it — purely cosmetic for people opening the sheet. */
export async function styleHeader(id: string, sheetId: number): Promise<void> {
  await gfetch(`${BASE}/${id}:batchUpdate`, {
    method: 'POST',
    body: JSON.stringify({
      requests: [
        { updateSheetProperties: { properties: { sheetId, gridProperties: { frozenRowCount: 1 } }, fields: 'gridProperties.frozenRowCount' } },
        {
          repeatCell: {
            range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
            cell: { userEnteredFormat: { textFormat: { bold: true }, backgroundColor: { red: 0.93, green: 0.96, blue: 0.95 } } },
            fields: 'userEnteredFormat(textFormat,backgroundColor)',
          },
        },
      ],
    }),
  });
}

/** Accepts a full URL or a bare id. */
export function parseSpreadsheetId(input: string): string {
  const m = /\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/.exec(input);
  return (m ? m[1]! : input).trim();
}

export function columnLetter(n: number): string {
  let s = '';
  for (let i = n; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s;
  return s;
}

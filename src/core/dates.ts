const TZ = 'Asia/Kolkata';

function fmt(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

export function todayIso(): string {
  return fmt(new Date());
}

export function daysAgoIso(days: number): string {
  return fmt(new Date(Date.now() - days * 86400_000));
}

export function monthOf(iso: string): string {
  return iso.slice(0, 7);
}

export function monthStart(month: string): string {
  return `${month}-01`;
}

export function monthEnd(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${month}-${String(last).padStart(2, '0')}`;
}

export function addMonths(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function monthLabel(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-IN', { month: 'short', year: 'numeric', timeZone: 'UTC' });
}

/** Gmail's after:/before: want YYYY/MM/DD. before is exclusive, so add a day. */
export function gmailDate(iso: string, plusDays = 0): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + plusDays);
  return d.toISOString().slice(0, 10).replace(/-/g, '/');
}

export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400_000);
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** Parse loose date strings (DD-MM-YYYY, DD/MM/YY, YYYY-MM-DD, "12 Aug 2026", Excel serials). */
export function parseLooseDate(raw: string | number, dayFirst = true): string | null {
  if (typeof raw === 'number') {
    // Google Sheets / Excel serial date (days since 1899-12-30).
    if (raw > 20000 && raw < 80000) return new Date(Date.UTC(1899, 11, 30) + raw * 86400_000).toISOString().slice(0, 10);
    return null;
  }
  const s = raw.trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m) return `${m[1]}-${m[2]!.padStart(2, '0')}-${m[3]!.padStart(2, '0')}`;
  m = /^(\d{1,2})[-/. ](\d{1,2})[-/. ](\d{2,4})/.exec(s);
  if (m) {
    const y = m[3]!.length === 2 ? `20${m[3]}` : m[3]!;
    const [a, b] = [m[1]!, m[2]!];
    const [d, mo] = dayFirst ? [a, b] : [b, a];
    return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  // "12 Aug 2026", "12-Aug-26", "12th August, 2026"
  m = /^(\d{1,2})(?:st|nd|rd|th)?[-/ ]([A-Za-z]{3})[A-Za-z]*\.?[-/ ,]+(\d{2,4})/.exec(s);
  if (m) {
    const mo = MONTHS.indexOf(m[2]!.toLowerCase().slice(0, 3)) + 1;
    if (mo > 0) return `${m[3]!.length === 2 ? `20${m[3]}` : m[3]}-${String(mo).padStart(2, '0')}-${m[1]!.padStart(2, '0')}`;
  }
  // "Aug 12, 2026", "August 12 2026"
  m = /^([A-Za-z]{3})[A-Za-z]*\.? (\d{1,2})(?:st|nd|rd|th)?,? (\d{4})/.exec(s);
  if (m) {
    const mo = MONTHS.indexOf(m[1]!.toLowerCase().slice(0, 3)) + 1;
    if (mo > 0) return `${m[3]}-${String(mo).padStart(2, '0')}-${m[2]!.padStart(2, '0')}`;
  }
  const t = Date.parse(s);
  if (Number.isNaN(t)) return null;
  // Date.parse yields local midnight — format in local time, never via toISOString (UTC would shift the day).
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

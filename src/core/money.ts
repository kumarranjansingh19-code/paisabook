/**
 * Deterministic money parsing — the LLM extracts amounts as strings; only this
 * code converts them to integer paise. Handles Indian formats:
 *   "1,23,456.78", "Rs. 1,234.50", "INR 500", "₹2,000", "1234.5", "1,234.56 Dr"
 */
export function parseAmountToPaise(raw: string | number): number {
  if (typeof raw === 'number') return Math.round(raw * 100);
  const cleaned = String(raw)
    .replace(/\b(dr|cr)\.?\s*$/i, '')
    .replace(/(rs\.?|inr|₹)/gi, '')
    .replace(/[,\s]/g, '')
    .replace(/^\((.*)\)$/, '-$1')
    .trim();
  if (!/^-?\d+(\.\d{1,2})?$/.test(cleaned)) {
    throw new Error(`Unparseable amount: "${raw}"`);
  }
  const negative = cleaned.startsWith('-');
  const [wholeRaw = '0', fracRaw = ''] = cleaned.replace('-', '').split('.');
  const paise = Number(wholeRaw) * 100 + Number(fracRaw.padEnd(2, '0').slice(0, 2) || '0');
  return negative ? -paise : paise;
}

export function formatPaise(paise: number, opts: { compact?: boolean; sign?: boolean } = {}): string {
  const abs = Math.abs(paise) / 100;
  const sign = paise < 0 ? '-' : opts.sign && paise > 0 ? '+' : '';
  if (opts.compact) {
    if (abs >= 1e7) return `${sign}₹${(abs / 1e7).toFixed(2)}Cr`;
    if (abs >= 1e5) return `${sign}₹${(abs / 1e5).toFixed(2)}L`;
    return `${sign}₹${abs.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
  }
  return `${sign}₹${abs.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

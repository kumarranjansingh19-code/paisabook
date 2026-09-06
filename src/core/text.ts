/**
 * Strip full account/card numbers down to last-4 before anything reaches the
 * LLM. Narrow on purpose so dates (18-08-2026) and amounts survive.
 */
export function redactPii(text: string): string {
  return text
    .replace(/\d{10,}/g, (m) => `XXXX${m.slice(-4)}`)
    .replace(/(?:\d{4}[ -]){2,}\d{4}/g, (m) => `XXXX${m.replace(/\D/g, '').slice(-4)}`);
}

export function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

export function b64urlToBytes(data: string): Uint8Array {
  const b64 = data.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(data.length / 4) * 4, '=');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function b64urlToText(data: string): string {
  return new TextDecoder().decode(b64urlToBytes(data));
}

export function emailAddress(from: string): string {
  const m = /<([^>]+)>/.exec(from);
  return (m ? m[1]! : from).trim().toLowerCase();
}

export function escapeHtml(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Bank emails usually explain the PDF password ("your password is DOB in DDMMYYYY + …"). */
export function passwordHint(body: string): string | null {
  const m = /password[^.\n]{0,60}?(?:is|:|would be|will be|=)\s*([^\n]{6,160})/i.exec(body);
  return m ? m[1]!.trim() : null;
}

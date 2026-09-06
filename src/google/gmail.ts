import { gfetch } from './auth';
import { mapPool } from '../core/pool';
import { b64urlToBytes, b64urlToText, stripHtml } from '../core/text';

const BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';

export interface EmailMeta {
  id: string;
  threadId: string;
  receivedAt: string; // ISO
  from: string;
  subject: string;
  snippet: string;
  hasPdf: boolean;
}

export interface FetchedEmail extends EmailMeta {
  bodyText: string;
  attachments: Array<{ attachmentId: string; filename: string; mimeType: string }>;
}

interface Part {
  mimeType?: string;
  filename?: string;
  body?: { data?: string; attachmentId?: string; size?: number };
  parts?: Part[];
  headers?: Array<{ name: string; value: string }>;
}
interface Message {
  id: string;
  threadId: string;
  internalDate: string;
  snippet?: string;
  payload?: Part;
}

function header(msg: Message, name: string): string {
  return msg.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';
}

function walk(p: Part | undefined, fn: (p: Part) => void): void {
  if (!p) return;
  fn(p);
  p.parts?.forEach((c) => walk(c, fn));
}

function extractBody(payload: Part | undefined): string {
  let plain = '';
  let html = '';
  walk(payload, (p) => {
    if (p.body?.data && p.mimeType === 'text/plain' && !plain) plain = b64urlToText(p.body.data);
    if (p.body?.data && p.mimeType === 'text/html' && !html) html = b64urlToText(p.body.data);
  });
  // HTML alerts often carry richer tables than the plain alternative.
  if (html && (!plain || plain.length < 80)) return stripHtml(html);
  return plain || stripHtml(html);
}

export async function listMessageIds(q: string, max = 5000, signal?: AbortSignal): Promise<string[]> {
  const ids: string[] = [];
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams({ q, maxResults: String(Math.min(500, max - ids.length)) });
    if (pageToken) params.set('pageToken', pageToken);
    const res = await gfetch<{ messages?: Array<{ id: string }>; nextPageToken?: string }>(`${BASE}/messages?${params}`, { signal });
    for (const m of res.messages ?? []) ids.push(m.id);
    pageToken = res.nextPageToken;
  } while (pageToken && ids.length < max);
  return ids;
}

/** Cheap pass: headers + snippet only (no bodies). */
export async function fetchMetas(ids: string[], onProgress?: (n: number) => void, signal?: AbortSignal): Promise<EmailMeta[]> {
  let done = 0;
  return mapPool(
    ids,
    10,
    async (id) => {
      const msg = await gfetch<Message>(
        `${BASE}/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`,
        { signal },
      );
      done++;
      onProgress?.(done);
      return metaOf(msg, false);
    },
    signal,
  );
}

function metaOf(msg: Message, hasPdf: boolean): EmailMeta {
  return {
    id: msg.id,
    threadId: msg.threadId,
    receivedAt: new Date(Number(msg.internalDate)).toISOString(),
    from: header(msg, 'From'),
    subject: header(msg, 'Subject'),
    snippet: msg.snippet ?? '',
    hasPdf,
  };
}

export async function fetchFull(ids: string[], onProgress?: (n: number) => void, signal?: AbortSignal): Promise<FetchedEmail[]> {
  let done = 0;
  return mapPool(
    ids,
    8,
    async (id) => {
      const msg = await gfetch<Message>(`${BASE}/messages/${id}?format=full`, { signal });
      const attachments: FetchedEmail['attachments'] = [];
      walk(msg.payload, (p) => {
        if (p.filename && p.body?.attachmentId) {
          attachments.push({ attachmentId: p.body.attachmentId, filename: p.filename, mimeType: p.mimeType ?? 'application/octet-stream' });
        }
      });
      const hasPdf = attachments.some((a) => /pdf/i.test(a.mimeType) || /\.pdf$/i.test(a.filename));
      done++;
      onProgress?.(done);
      return { ...metaOf(msg, hasPdf), bodyText: extractBody(msg.payload).slice(0, 8000), attachments };
    },
    signal,
  );
}

export async function downloadAttachment(messageId: string, attachmentId: string): Promise<Uint8Array> {
  const res = await gfetch<{ data?: string }>(`${BASE}/messages/${messageId}/attachments/${attachmentId}`);
  if (!res.data) throw new Error('attachment has no data');
  return b64urlToBytes(res.data);
}

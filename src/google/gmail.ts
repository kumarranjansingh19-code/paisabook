import { gfetch, gfetchRaw } from './auth';
import { chunk, mapPool } from '../core/pool';
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
    await throttle(5);
    const res = await gfetch<{ messages?: Array<{ id: string }>; nextPageToken?: string }>(`${BASE}/messages?${params}`, { signal });
    for (const m of res.messages ?? []) ids.push(m.id);
    pageToken = res.nextPageToken;
  } while (pageToken && ids.length < max);
  return ids;
}

const BATCH_SIZE = 20;
const BATCH_CONCURRENCY = 2;

/**
 * Gmail's per-user quota differs between projects (documented 15,000
 * units/min, observed lower). messages.get costs 5 units. A token bucket
 * paces reads; the pace halves on every 429 and creeps back up after a quiet
 * spell, and the value that works is remembered on the device.
 */
const PACE_KEY = 'paisabook.gmailPace.v1';
const PACE_MAX = 200;
const PACE_MIN = 25; // 5 reads/s — slow but never glacial
const UNITS_PER_READ = 5;
let unitsPerSec = readPace();
let bucket = unitsPerSec;
let lastRefill = Date.now();
let lastLimitAt = 0;

function readPace(): number {
  try {
    const v = Number(globalThis.localStorage?.getItem(PACE_KEY));
    return v >= PACE_MIN && v <= PACE_MAX ? v : 60;
  } catch {
    return 60;
  }
}
function savePace(): void {
  try {
    globalThis.localStorage?.setItem(PACE_KEY, String(unitsPerSec));
  } catch {
    /* ignore */
  }
}
/** Current pace in message reads per second. */
export function gmailPace(): number {
  return Math.round(unitsPerSec / 5);
}
if (typeof window !== 'undefined') {
  window.addEventListener('paisabook:ratelimit', (e) => {
    const d = (e as CustomEvent<{ status: number; url?: string }>).detail;
    if (d.status !== 429 || !/gmail/.test(d.url ?? '')) return;
    if (Date.now() - lastLimitAt < 5000) return; // one halving per burst
    lastLimitAt = Date.now();
    unitsPerSec = Math.max(PACE_MIN, Math.floor(unitsPerSec / 2));
    bucket = 0;
    savePace();
  });
}
/** Messages per batch request: fewer when the pace is low so one batch never exceeds the bucket. */
function batchSize(): number {
  return Math.max(5, Math.min(BATCH_SIZE, Math.floor(unitsPerSec / UNITS_PER_READ)));
}
async function throttle(units: number): Promise<void> {
  for (;;) {
    const now = Date.now();
    if (lastLimitAt && now - lastLimitAt > 90_000 && unitsPerSec < PACE_MAX) {
      unitsPerSec = Math.min(PACE_MAX, Math.floor(unitsPerSec * 1.25));
      lastLimitAt = now;
      savePace();
    }
    // The bucket must be able to hold one request's cost, or a request could wait forever.
    const cap = Math.max(unitsPerSec * 2, units);
    bucket = Math.min(cap, bucket + ((now - lastRefill) / 1000) * unitsPerSec);
    lastRefill = now;
    if (bucket >= units) {
      bucket -= units;
      return;
    }
    await new Promise((r) => setTimeout(r, Math.min(5000, Math.ceil(((units - bucket) / unitsPerSec) * 1000))));
  }
}

interface BatchPart {
  status: number;
  body: string;
}

/** Parse a multipart/mixed batch response into ordered parts (by Content-ID, else by position). */
export function parseBatch(text: string, boundary: string): BatchPart[] {
  const parts: Array<{ idx: number; part: BatchPart }> = [];
  const chunks = text.split(`--${boundary}`).slice(1);
  chunks.forEach((raw, position) => {
    if (raw.startsWith('--')) return; // closing marker
    const norm = raw.replace(/\r\n/g, '\n');
    const firstBlank = norm.indexOf('\n\n');
    if (firstBlank < 0) return;
    const partHeaders = norm.slice(0, firstBlank);
    const inner = norm.slice(firstBlank + 2);
    const statusLine = /^HTTP\/[\d.]+ (\d{3})/m.exec(inner);
    const secondBlank = inner.indexOf('\n\n');
    const body = secondBlank >= 0 ? inner.slice(secondBlank + 2).trim() : '';
    const idm = /Content-ID:\s*<response-item(\d+)>/i.exec(partHeaders);
    parts.push({ idx: idm ? Number(idm[1]) : position, part: { status: statusLine ? Number(statusLine[1]) : 0, body } });
  });
  return parts.sort((a, b) => a.idx - b.idx).map((p) => p.part);
}

/**
 * Fetch many messages in one HTTP round trip via the Gmail batch endpoint.
 * Items that fail inside the batch (rate limit, transient) are retried one by one.
 */
async function batchGet(ids: string[], query: string, signal?: AbortSignal): Promise<Message[]> {
  await throttle(ids.length * UNITS_PER_READ);
  const boundary = `paisabook_${Math.random().toString(36).slice(2)}`;
  const body =
    ids.map((id, i) => `--${boundary}\r\nContent-Type: application/http\r\nContent-ID: <item${i}>\r\n\r\nGET /gmail/v1/users/me/messages/${id}?${query} HTTP/1.1\r\n\r\n`).join('') +
    `--${boundary}--`;
  const res = await gfetchRaw('https://www.googleapis.com/batch/gmail/v1', {
    method: 'POST',
    headers: { 'Content-Type': `multipart/mixed; boundary=${boundary}` },
    body,
    signal,
  });
  const rb = /boundary="?([^";]+)"?/.exec(res.headers.get('Content-Type') ?? '')?.[1];
  const parts = rb ? parseBatch(await res.text(), rb) : [];
  const out: Message[] = [];
  for (let i = 0; i < ids.length; i++) {
    const part = parts[i];
    if (part && part.status === 200) {
      try {
        out.push(JSON.parse(part.body) as Message);
        continue;
      } catch {
        /* fall through to single fetch */
      }
    }
    if (part && part.status === 404) continue; // message deleted meanwhile
    await throttle(5);
    out.push(await gfetch<Message>(`${BASE}/messages/${ids[i]}?${query}`, { signal }));
  }
  return out;
}

export interface FetchOpts<T> {
  onProgress?: (n: number) => void;
  /** called as each batch lands — lets callers checkpoint partial progress */
  onBatch?: (items: T[]) => void;
  signal?: AbortSignal;
}

async function fetchMany(ids: string[], query: string, opts: FetchOpts<Message>): Promise<Message[]> {
  let done = 0;
  const batches = await mapPool(
    chunk(ids, batchSize()),
    BATCH_CONCURRENCY,
    async (batch, _i, poolSignal) => {
      const msgs = await batchGet(batch, query, poolSignal);
      done += batch.length;
      opts.onBatch?.(msgs);
      opts.onProgress?.(done);
      return msgs;
    },
    opts.signal,
  );
  return batches.flat();
}

/** Cheap pass: headers + snippet only (no bodies). */
export async function fetchMetas(ids: string[], opts: FetchOpts<EmailMeta> = {}): Promise<EmailMeta[]> {
  const msgs = await fetchMany(ids, 'format=metadata&metadataHeaders=From&metadataHeaders=Subject', {
    onProgress: opts.onProgress,
    signal: opts.signal,
    onBatch: opts.onBatch ? (ms) => opts.onBatch!(ms.map((m) => metaOf(m, false))) : undefined,
  });
  return msgs.map((m) => metaOf(m, false));
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

function fullOf(msg: Message): FetchedEmail {
  const attachments: FetchedEmail['attachments'] = [];
  walk(msg.payload, (p) => {
    if (p.filename && p.body?.attachmentId) {
      attachments.push({ attachmentId: p.body.attachmentId, filename: p.filename, mimeType: p.mimeType ?? 'application/octet-stream' });
    }
  });
  const hasPdf = attachments.some((a) => /pdf/i.test(a.mimeType) || /\.pdf$/i.test(a.filename));
  return { ...metaOf(msg, hasPdf), bodyText: extractBody(msg.payload).slice(0, 8000), attachments };
}

export async function fetchFull(ids: string[], opts: FetchOpts<FetchedEmail> = {}): Promise<FetchedEmail[]> {
  const msgs = await fetchMany(ids, 'format=full', {
    onProgress: opts.onProgress,
    signal: opts.signal,
    onBatch: opts.onBatch ? (ms) => opts.onBatch!(ms.map(fullOf)) : undefined,
  });
  return msgs.map(fullOf);
}

export async function downloadAttachment(messageId: string, attachmentId: string): Promise<Uint8Array> {
  const res = await gfetch<{ data?: string }>(`${BASE}/messages/${messageId}/attachments/${attachmentId}`);
  if (!res.data) throw new Error('attachment has no data');
  return b64urlToBytes(res.data);
}

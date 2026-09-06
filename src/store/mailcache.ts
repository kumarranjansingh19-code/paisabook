/**
 * Device cache of mail already downloaded from Gmail (headers and bodies,
 * never attachment bytes). Every Gmail read costs quota, and discovery, a
 * re-run after a rate limit, and the first sync all want the same messages:
 * whatever landed once is served from here from then on.
 */
import type { EmailMeta, FetchedEmail } from '../google/gmail';

const DB = 'paisabook-mail';
const VERSION = 1;
let dbp: Promise<IDBDatabase | null> | null = null;

function open(): Promise<IDBDatabase | null> {
  if (dbp) return dbp;
  dbp = new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') return resolve(null);
    const req = indexedDB.open(DB, VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains('metas')) d.createObjectStore('metas', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('emails')) d.createObjectStore('emails', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
  return dbp;
}

async function getMany<T>(store: string, ids: string[]): Promise<Map<string, T>> {
  const out = new Map<string, T>();
  const d = await open();
  if (!d || !ids.length) return out;
  await new Promise<void>((resolve) => {
    const tx = d.transaction(store, 'readonly');
    const os = tx.objectStore(store);
    for (const id of ids) {
      const r = os.get(id);
      r.onsuccess = () => {
        if (r.result) out.set(id, r.result as T);
      };
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
    tx.onabort = () => resolve();
  });
  return out;
}

async function putMany(store: string, items: Array<{ id: string }>): Promise<void> {
  const d = await open();
  if (!d || !items.length) return;
  await new Promise<void>((resolve) => {
    const tx = d.transaction(store, 'readwrite');
    const os = tx.objectStore(store);
    for (const it of items) os.put(it);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
    tx.onabort = () => resolve();
  });
}

export const getCachedMetas = (ids: string[]) => getMany<EmailMeta>('metas', ids);
export const putCachedMetas = (metas: EmailMeta[]) => putMany('metas', metas);
export const getCachedEmails = (ids: string[]) => getMany<FetchedEmail>('emails', ids);
export const putCachedEmails = (emails: FetchedEmail[]) => putMany('emails', emails);

export async function cacheStats(): Promise<{ metas: number; emails: number }> {
  const d = await open();
  if (!d) return { metas: 0, emails: 0 };
  const count = (store: string) =>
    new Promise<number>((resolve) => {
      const r = d.transaction(store, 'readonly').objectStore(store).count();
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => resolve(0);
    });
  return { metas: await count('metas'), emails: await count('emails') };
}

export async function clearMailCache(): Promise<void> {
  const d = await open();
  if (!d) return;
  await new Promise<void>((resolve) => {
    const tx = d.transaction(['metas', 'emails'], 'readwrite');
    tx.objectStore('metas').clear();
    tx.objectStore('emails').clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

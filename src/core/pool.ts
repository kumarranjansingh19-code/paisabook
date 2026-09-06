/**
 * Map over items with at most `limit` concurrent executions. The first
 * failure aborts every in-flight request (via the signal handed to `fn`) and
 * stops the remaining workers, so a rate-limit error surfaces immediately and
 * nothing keeps retrying in the background. Also aborts on the caller's signal.
 */
export async function mapPool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number, signal: AbortSignal) => Promise<R>,
  signal?: AbortSignal,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  const ctl = new AbortController();
  const onOuterAbort = () => ctl.abort(signal?.reason);
  if (signal?.aborted) onOuterAbort();
  signal?.addEventListener('abort', onOuterAbort, { once: true });
  let next = 0;
  let failure: unknown = null;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length && failure === null && !ctl.signal.aborted) {
      const i = next++;
      try {
        results[i] = await fn(items[i] as T, i, ctl.signal);
      } catch (err) {
        if (failure === null) failure = err;
        ctl.abort();
        throw err;
      }
    }
  });
  try {
    await Promise.all(workers);
  } finally {
    signal?.removeEventListener('abort', onOuterAbort);
  }
  if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
  return results;
}

export function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

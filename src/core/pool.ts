/**
 * Map over items with at most `limit` concurrent executions. The first
 * failure stops the remaining workers (so a rate-limit error surfaces instead
 * of other workers overwriting it with progress updates). Aborts on `signal`.
 */
export async function mapPool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
  signal?: AbortSignal,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  let failed = false;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length && !failed) {
      if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
      const i = next++;
      try {
        results[i] = await fn(items[i] as T, i);
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  });
  await Promise.all(workers);
  return results;
}

export function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Run `fn` over `items` with at most `limit` calls in flight at once,
 * returning the results in **input order** — not completion order.
 *
 * A fixed pool of `limit` workers pulls the next index off a shared
 * cursor until the input is exhausted, so the index build can overlap
 * file I/O without flooding the file system with thousands of concurrent
 * reads. `limit` is clamped to `[1, items.length]`; empty input resolves
 * to an empty array without invoking `fn`.
 */
export async function mapLimit<T, R>(
  items: ReadonlyArray<T>,
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;

  const worker = async (): Promise<void> => {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await fn(items[i], i);
    }
  };

  const poolSize = Math.max(1, Math.min(limit, items.length));
  const pool: Promise<void>[] = [];
  for (let w = 0; w < poolSize; w++) {
    pool.push(worker());
  }
  await Promise.all(pool);
  return results;
}

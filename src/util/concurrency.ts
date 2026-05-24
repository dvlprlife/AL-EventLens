/**
 * Run `fn` over `items` with at most `limit` calls in flight at once,
 * returning the results in **input order** — not completion order.
 *
 * A fixed pool of `limit` workers pulls the next index off a shared
 * cursor until the input is exhausted, so the index build can overlap
 * file I/O without flooding the file system with thousands of concurrent
 * reads. `limit` is clamped to `[1, items.length]`; empty input resolves
 * to an empty array without invoking `fn`.
 *
 * Error handling: by default a worker's rejection propagates and aborts
 * the entire batch (existing contract). Passing `{ onError: 'skip' }`
 * instead isolates per-task failures — the worker logs via `console.warn`
 * and leaves that slot `undefined`, so a transient `EBUSY`/`ENOENT` on
 * one input never aborts the surrounding pass. Input-order guarantee
 * still holds; skipped slots remain `undefined` in their original index.
 */
export interface MapLimitOptions {
  /** `'throw'` (default) preserves the original contract — a worker
   *  rejection aborts the batch. `'skip'` swallows the rejection and
   *  leaves the slot `undefined`. */
  readonly onError?: 'throw' | 'skip';
  /** Prefix attached to the per-task `console.warn` emitted under
   *  `onError: 'skip'`. Defaults to `'AL EventLens: mapLimit task'`.
   *  Has no effect under `onError: 'throw'`. */
  readonly warnLabel?: string;
}

// Overloads: default / explicit `'throw'` keeps the strict `R[]` shape so
// existing callers don't have to filter undefined; `'skip'` widens the
// result to `(R | undefined)[]` so the type reflects the new behavior.
export function mapLimit<T, R>(
  items: ReadonlyArray<T>,
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]>;
export function mapLimit<T, R>(
  items: ReadonlyArray<T>,
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
  options: MapLimitOptions & { onError?: 'throw' }
): Promise<R[]>;
export function mapLimit<T, R>(
  items: ReadonlyArray<T>,
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
  options: MapLimitOptions & { onError: 'skip' }
): Promise<(R | undefined)[]>;
export async function mapLimit<T, R>(
  items: ReadonlyArray<T>,
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
  options?: MapLimitOptions
): Promise<(R | undefined)[]> {
  const onError = options?.onError ?? 'throw';
  const warnLabel = options?.warnLabel ?? 'AL EventLens: mapLimit task';
  // Fill instead of `new Array(items.length)` so a skipped slot under
  // `onError: 'skip'` is explicit `undefined`, not a hole — callers can
  // iterate with `for…of` without sparse-array surprises and shallow
  // equality checks compare cleanly.
  const results: (R | undefined)[] = new Array(items.length).fill(undefined);
  let cursor = 0;

  const worker = async (): Promise<void> => {
    while (cursor < items.length) {
      const i = cursor++;
      if (onError === 'skip') {
        try {
          results[i] = await fn(items[i], i);
        } catch (err) {
          console.warn(`${warnLabel} ${i} failed: ${err}`);
          // results[i] stays undefined.
        }
      } else {
        results[i] = await fn(items[i], i);
      }
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

import * as assert from 'assert';
import { mapLimit } from '../../util/concurrency';

const delay = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms));

suite('util/concurrency: mapLimit', () => {
  test('returns results in input order regardless of completion order', async () => {
    // Earlier items resolve later — the result array must still match input
    // order, not the order the promises settled in.
    const out = await mapLimit([30, 5, 15], 3, async (ms, i) => {
      await delay(ms);
      return i;
    });
    assert.deepStrictEqual(out, [0, 1, 2]);
  });

  test('maps each value through fn', async () => {
    const out = await mapLimit([1, 2, 3, 4], 2, async (n) => n * 10);
    assert.deepStrictEqual(out, [10, 20, 30, 40]);
  });

  test('never exceeds the concurrency limit, but does parallelize', async () => {
    let inFlight = 0;
    let peak = 0;
    const items = Array.from({ length: 20 }, (_, i) => i);
    await mapLimit(items, 4, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await delay(5);
      inFlight--;
      return null;
    });
    assert.ok(peak <= 4, `peak concurrency ${peak} must not exceed the limit of 4`);
    assert.ok(peak >= 2, `peak concurrency ${peak} should show actual parallelism`);
  });

  test('empty input resolves to an empty array without invoking fn', async () => {
    let calls = 0;
    const out = await mapLimit([], 8, async () => {
      calls++;
      return 1;
    });
    assert.deepStrictEqual(out, []);
    assert.strictEqual(calls, 0);
  });

  test('a limit larger than the input size is harmless', async () => {
    const out = await mapLimit([1, 2], 100, async (n) => n);
    assert.deepStrictEqual(out, [1, 2]);
  });
});

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

  test('default error handling: a single rejection aborts the batch (regression guard)', async () => {
    // Preserves the contract every existing call site relies on — pass
    // no `onError`, and a worker rejection propagates exactly like the
    // pre-options version of mapLimit.
    await assert.rejects(
      mapLimit([1, 2, 3], 3, async (n) => {
        if (n === 2) {
          throw new Error('boom');
        }
        return n * 10;
      }),
      /boom/
    );
  });

  test('explicit onError: throw still aborts the batch', async () => {
    await assert.rejects(
      mapLimit(
        [1, 2, 3],
        3,
        async (n) => {
          if (n === 2) {
            throw new Error('boom');
          }
          return n * 10;
        },
        { onError: 'throw' }
      ),
      /boom/
    );
  });

  test('onError: skip isolates failures — undefined in failing slot, success in the others, input order preserved', async () => {
    // Capture console.warn so the test doesn't leak noise and we can
    // assert the failing index was logged.
    const originalWarn = console.warn;
    const warns: string[] = [];
    (console as { warn: (...args: unknown[]) => void }).warn = (...args: unknown[]): void => {
      warns.push(args.map((a) => String(a)).join(' '));
    };
    try {
      const out = await mapLimit(
        [1, 2, 3, 4],
        2,
        async (n) => {
          if (n === 2) {
            throw new Error('boom');
          }
          return n * 10;
        },
        { onError: 'skip' }
      );
      assert.deepStrictEqual(out, [10, undefined, 30, 40],
        'input order preserved; failing slot is undefined');
      assert.strictEqual(warns.length, 1, 'exactly one warn for the one failure');
      assert.ok(warns[0].includes('boom'), `warn must mention the underlying error: ${warns[0]}`);
      // Default warnLabel mentions "mapLimit task"; with a custom label
      // a different prefix would appear (covered in the next test).
      assert.ok(
        warns[0].includes('mapLimit task') || warns[0].includes('failed'),
        `warn must carry a recognizable label: ${warns[0]}`
      );
    } finally {
      console.warn = originalWarn;
    }
  });

  test('onError: skip with a custom warnLabel uses the label in the warn output', async () => {
    const originalWarn = console.warn;
    const warns: string[] = [];
    (console as { warn: (...args: unknown[]) => void }).warn = (...args: unknown[]): void => {
      warns.push(args.map((a) => String(a)).join(' '));
    };
    try {
      await mapLimit(
        [1, 2],
        2,
        async () => { throw new Error('x'); },
        { onError: 'skip', warnLabel: 'CUSTOM-PREFIX' }
      );
      assert.ok(warns.every((w) => w.startsWith('CUSTOM-PREFIX')),
        `every warn must start with the custom label; got: ${JSON.stringify(warns)}`);
    } finally {
      console.warn = originalWarn;
    }
  });
});

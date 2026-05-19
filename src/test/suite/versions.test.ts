import * as assert from 'assert';
import { compareVersions } from '../../util/versions';

suite('util/versions: compareVersions', () => {
  test('returns 0 for identical versions', () => {
    assert.strictEqual(compareVersions('1.0.0.0', '1.0.0.0'), 0);
    assert.strictEqual(compareVersions('28.0.46665.50105', '28.0.46665.50105'), 0);
  });

  test('compares major version numerically (not lexically)', () => {
    // Lexical compare would put '10.0' before '9.0' — must not.
    assert.ok(compareVersions('10.0.0.0', '9.0.0.0') > 0);
    assert.ok(compareVersions('9.0.0.0', '10.0.0.0') < 0);
  });

  test('compares each segment in order — first differing wins', () => {
    assert.ok(compareVersions('28.0.46665.50105', '28.0.46665.50104') > 0);
    assert.ok(compareVersions('28.0.46665.50105', '28.0.46664.99999') > 0);
    assert.ok(compareVersions('28.1.0.0', '28.0.99999.99999') > 0);
    assert.ok(compareVersions('29.0.0.0', '28.99999.99999.99999') > 0);
  });

  test('treats missing trailing segments as zero', () => {
    assert.strictEqual(compareVersions('1.0', '1.0.0.0'), 0);
    assert.strictEqual(compareVersions('1.0.0', '1.0'), 0);
    assert.ok(compareVersions('1.0.1', '1.0') > 0);
    assert.ok(compareVersions('1.0', '1.0.1') < 0);
  });

  test('BC base-app versions sort the way the dedupe needs', () => {
    const a = '26.5.38752.40837';
    const b = '27.0.38460.40863';
    const c = '28.0.46665.50105';
    const sorted = [c, a, b].sort(compareVersions);
    assert.deepStrictEqual(sorted, [a, b, c]);
  });

  test('non-numeric segments sort below any numeric segment so a malformed manifest cannot displace a real one', () => {
    assert.ok(compareVersions('1.0.0.0', '1.0.0.bad') > 0);
    assert.ok(compareVersions('1.0.0.bad', '1.0.0.0') < 0);
    // Two non-numerics compare equal because both parse to -1.
    assert.strictEqual(compareVersions('1.0.0.bad', '1.0.0.also-bad'), 0);
  });

  test('empty string sorts below any real version', () => {
    assert.ok(compareVersions('', '0.0.0.0') < 0);
    assert.ok(compareVersions('1.0.0.0', '') > 0);
  });
});

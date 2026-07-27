import * as assert from 'assert';
import * as vscode from 'vscode';
import { revivePosition, reviveRange } from '../../util/reviveLocation';

suite('util/reviveLocation: revivePosition', () => {
  test('plain {line, character} round-trips', () => {
    assert.deepStrictEqual(revivePosition({ line: 5, character: 12 }), { line: 5, character: 12 });
  });

  test('non-object input yields (0, 0)', () => {
    assert.deepStrictEqual(revivePosition(undefined), { line: 0, character: 0 });
    assert.deepStrictEqual(revivePosition(null), { line: 0, character: 0 });
    assert.deepStrictEqual(revivePosition(42 as unknown), { line: 0, character: 0 });
  });

  test('missing fields default to 0', () => {
    assert.deepStrictEqual(revivePosition({ line: 3 }), { line: 3, character: 0 });
    assert.deepStrictEqual(revivePosition({ character: 7 }), { line: 0, character: 7 });
    assert.deepStrictEqual(revivePosition({}), { line: 0, character: 0 });
  });

  test('non-number fields default to 0', () => {
    assert.deepStrictEqual(revivePosition({ line: '5' as unknown, character: 12 }),
      { line: 0, character: 12 });
  });

  test('negative line/character clamp to 0 (#133)', () => {
    // vscode.Position/Range throw illegalArgument on a negative; clamp so
    // gotoSubscriber falls back to (0,0) instead of surfacing an error toast.
    assert.deepStrictEqual(revivePosition({ line: -1, character: 4 }), { line: 0, character: 4 });
    assert.deepStrictEqual(revivePosition({ line: 4, character: -7 }), { line: 4, character: 0 });
    assert.deepStrictEqual(revivePosition({ line: -1, character: -1 }), { line: 0, character: 0 });
  });

  test('non-integer line/character floor to a valid coordinate (#133)', () => {
    assert.deepStrictEqual(revivePosition({ line: 2.9, character: 5.1 }), { line: 2, character: 5 });
    // NaN is not >= 0, so it falls through to 0.
    assert.deepStrictEqual(revivePosition({ line: NaN, character: 3 }), { line: 0, character: 3 });
  });
});

suite('util/reviveLocation: reviveRange', () => {
  test('plain {start, end} shape — the JSON-style serialization', () => {
    const r = reviveRange({
      start: { line: 5, character: 0 },
      end: { line: 5, character: 10 }
    });
    assert.ok(r instanceof vscode.Range);
    assert.strictEqual(r.start.line, 5);
    assert.strictEqual(r.start.character, 0);
    assert.strictEqual(r.end.line, 5);
    assert.strictEqual(r.end.character, 10);
  });

  test('underscore-prefixed {_start, _end} shape — the internal-slots-only clone', () => {
    // This is what `postMessage` from a webview produces when vscode.Range's
    // public `start`/`end` getters get stripped during structured clone and
    // only the internal _start/_end data properties survive. The regression
    // this whole helper exists to catch.
    const r = reviveRange({
      _start: { line: 7, character: 4 },
      _end: { line: 7, character: 4 }
    });
    assert.strictEqual(r.start.line, 7);
    assert.strictEqual(r.start.character, 4);
    assert.strictEqual(r.end.line, 7);
    assert.strictEqual(r.end.character, 4);
  });

  test('mixed: start present, end missing → end falls back to start', () => {
    // Defensive — if only one position survives, the resulting Range collapses
    // to a caret at start. Better than crashing with NaN line numbers.
    const r = reviveRange({ start: { line: 3, character: 2 } });
    assert.strictEqual(r.start.line, 3);
    assert.strictEqual(r.end.line, 3);
    assert.strictEqual(r.start.character, 2);
    assert.strictEqual(r.end.character, 2);
  });

  test('real vscode.Range instance — getters work, no special handling needed', () => {
    const input = new vscode.Range(2, 5, 4, 10);
    const r = reviveRange(input);
    assert.strictEqual(r.start.line, 2);
    assert.strictEqual(r.start.character, 5);
    assert.strictEqual(r.end.line, 4);
    assert.strictEqual(r.end.character, 10);
  });

  test('empty object → (0, 0, 0, 0) Range — no crash even when EVERYTHING is missing', () => {
    const r = reviveRange({});
    assert.strictEqual(r.start.line, 0);
    assert.strictEqual(r.end.line, 0);
  });

  test('non-object input → (0, 0, 0, 0) Range', () => {
    assert.strictEqual(reviveRange(undefined).start.line, 0);
    assert.strictEqual(reviveRange(null).start.line, 0);
    assert.strictEqual(reviveRange(42).start.line, 0);
  });

  test('negative coordinates produce a valid Range, not a throw (#133)', () => {
    // Pre-clamp this threw illegalArgument out of the un-try/caught
    // gotoSubscriber handler. A built vscode.Range proves no throw.
    let r: vscode.Range | undefined;
    assert.doesNotThrow(() => {
      r = reviveRange({ start: { line: -3, character: -2 }, end: { line: -1, character: -1 } });
    });
    assert.ok(r);
    assert.strictEqual(r!.start.line, 0);
    assert.strictEqual(r!.start.character, 0);
    assert.strictEqual(r!.end.line, 0);
    assert.strictEqual(r!.end.character, 0);
  });

  test('array shape — what Range.toJSON() actually produces (#185)', () => {
    // JSON.stringify (the webview boundary) calls toJSON(); vscode.Range's
    // returns [start, end], not {start, end}. Arrays are objects, so the
    // helper's typeof guard passes and both property lookups miss — which is
    // how every panel-originated gotoSubscriber used to land at line 1.
    const r = reviveRange([{ line: 42, character: 4 }, { line: 42, character: 9 }]);
    assert.ok(r instanceof vscode.Range);
    assert.strictEqual(r.start.line, 42);
    assert.strictEqual(r.start.character, 4);
    assert.strictEqual(r.end.line, 42);
    assert.strictEqual(r.end.character, 9);
  });

  test('single-element array → end falls back to start (#185)', () => {
    // Mirrors the existing start-only case: parseAl builds every Location from
    // one vscode.Position, so collapsing to a caret is the accurate fallback.
    const r = reviveRange([{ line: 7, character: 1 }]);
    assert.strictEqual(r.start.line, 7);
    assert.strictEqual(r.start.character, 1);
    assert.strictEqual(r.end.line, 7);
    assert.strictEqual(r.end.character, 1);
  });

  test('empty array → (0, 0, 0, 0) Range, no throw (#185)', () => {
    let r: vscode.Range | undefined;
    assert.doesNotThrow(() => { r = reviveRange([]); });
    assert.ok(r);
    assert.strictEqual(r!.start.line, 0);
    assert.strictEqual(r!.end.line, 0);
  });

  test('array elements clamp exactly like the object path (#185)', () => {
    let r: vscode.Range | undefined;
    assert.doesNotThrow(() => {
      r = reviveRange([{ line: -3, character: -2 }, { line: -1, character: -1 }]);
    });
    assert.ok(r);
    assert.strictEqual(r!.start.line, 0);
    assert.strictEqual(r!.start.character, 0);
    assert.strictEqual(r!.end.line, 0);
    assert.strictEqual(r!.end.character, 0);
  });

  test('REAL JSON round trip of a vscode.Range revives to the same coordinates (#185)', () => {
    // Every other fixture here is hand-written; this one asks the running
    // extension host what it actually serializes. Asserted behaviourally
    // (coordinates in, same coordinates out) rather than on the serialized
    // shape: `.vscode-test.mjs` pins `version: 'stable'`, so the host floats
    // forward and a shape assertion would redden CI on any future
    // serialization change even where revival still works. If a future host
    // ever emits a shape reviveRange can't handle, the coordinates come back
    // (0, 0) and this fails loudly — which is the point.
    const original = new vscode.Range(12, 4, 15, 9);
    const overTheWire = JSON.parse(JSON.stringify(original)) as unknown;
    const r = reviveRange(overTheWire);
    assert.ok(r instanceof vscode.Range);
    assert.strictEqual(r.start.line, original.start.line);
    assert.strictEqual(r.start.character, original.start.character);
    assert.strictEqual(r.end.line, original.end.line);
    assert.strictEqual(r.end.character, original.end.character);
  });
});

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
});

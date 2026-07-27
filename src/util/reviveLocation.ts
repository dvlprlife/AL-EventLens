import * as vscode from 'vscode';

/**
 * Reconstruct a `vscode.Range` from whatever shape arrives at a command
 * handler that was invoked via a webview `postMessage`.
 *
 * The webview boundary serializes with `JSON.stringify`, which **calls
 * `toJSON()`**. `vscode.Range.toJSON()` returns `[start, end]` and
 * `vscode.Position.toJSON()` returns `{line, character}`, so a `Location.range`
 * that has crossed that boundary arrives host-side as a two-element **array**:
 * `[{line, character}, {line, character}]` (#185).
 *
 * Three further shapes are tolerated defensively, for payloads that reach us
 * pre-shaped rather than across that boundary:
 *
 * - `{start, end}` — a hand-built or already-`Range`-shaped bag, e.g. a plain
 *   object literal an in-process caller assembled itself.
 * - `{_start, _end}` — vscode.Range's internal data slots (`_start`/`_end`;
 *   the public `start`/`end` are prototype getters). This **is** genuine
 *   `structuredClone` output: structured clone copies own enumerable data
 *   properties and **ignores `toJSON()`**, and vscode.Position hides its data
 *   behind getters too (`get line() { return this._line; }`, constructor
 *   assigns `this._line`/`this._character`), so the inner positions arrive
 *   underscore-spelled as well —
 *   `{_start: {_line, _character}, _end: {_line, _character}}`.
 *   `revivePosition` below reads both spellings (`line ?? _line`), so this
 *   one branch covers the genuine clone and the hand-built hybrid
 *   `{_start: {line, character}}` that predates it (#196). No production
 *   caller sends either shape today — the webview hop is `JSON.stringify`,
 *   i.e. the array branch above — but a future `postMessage` path that
 *   structured-clones instead would.
 * - `{}` — nothing useful survived.
 *
 * Real in-process callers (CodeLens, Tree, anything dispatched inside the
 * extension host with no postMessage hop) hand us a true `vscode.Range`
 * instance whose getters work — the `r.start` branch fires immediately.
 *
 * Falls back to `(0, 0)` so `showTextDocument` still opens the file even
 * when position info is fully missing.
 */
export function reviveRange(input: unknown): vscode.Range {
  if (typeof input !== 'object' || input === null) {
    return new vscode.Range(0, 0, 0, 0);
  }
  // `JSON.stringify` — which is what the webview hop uses — calls `toJSON()`,
  // and `vscode.Range.toJSON()` returns `[start, end]`. Arrays are objects, so
  // this must be checked ahead of the property lookups below: they both miss on
  // an array and silently collapse the Range to (0, 0, 0, 0) (#185).
  if (Array.isArray(input)) {
    const parts: unknown[] = input;
    const start = revivePosition(parts[0]);
    // Same end-falls-back-to-start rule as the object path: accurate for the
    // caret-only Locations `parseAl` builds.
    const end = revivePosition(parts[1] ?? parts[0]);
    return new vscode.Range(start.line, start.character, end.line, end.character);
  }
  const r = input as {
    start?: unknown; end?: unknown;
    _start?: unknown; _end?: unknown;
  };
  const start = revivePosition(r.start ?? r._start);
  // End falls back to start when only one position survived — accurate
  // for caret-only Locations, which is how `parseAl` builds them.
  const end = revivePosition(r.end ?? r._end ?? r.start ?? r._start);
  return new vscode.Range(start.line, start.character, end.line, end.character);
}

/**
 * Same defensive pattern for a single `vscode.Position`. Returns plain
 * `{line, character}` rather than a `vscode.Position` because the result
 * is passed straight into the `vscode.Range` constructor.
 *
 * Accepts both spellings of each coordinate: the public `line`/`character`
 * (what `Position.toJSON()` emits, so what survives the `JSON.stringify`
 * webview hop) and the internal `_line`/`_character` data slots (what a
 * genuine `structuredClone` leaves behind, since it ignores `toJSON()`).
 * `??`, not `||`, so a present-but-zero public coordinate still wins; a
 * present-but-non-numeric `line` shadows `_line` and clamps to 0, exactly
 * as a lone non-numeric `line` always has.
 *
 * Kept deliberately in step with `lineOf` in `src/ui/panelHtml.ts` — the
 * webview-side twin that reads the same shape set off the same payloads
 * (`r.start || r._start || r[0]`, then `s.line != null ? s.line : s._line`).
 * The two drifted once (#196); change one, change the other.
 *
 * Negative or non-integer coordinates are clamped/floored to a valid value —
 * whichever spelling won the `??`, since the spelling is resolved first and a
 * single guarded expression per coordinate produces the result:
 * `vscode.Position`/`Range` throw `illegalArgument` on a negative or
 * non-integer, and `gotoSubscriber` invokes `reviveRange` outside any
 * try/catch, so a malformed payload would otherwise surface a generic
 * error toast instead of this helper's `(0,0)` fallback.
 * `Math.floor` also coerces non-integers; `>= 0` is `false` for `NaN`, so
 * `NaN` falls through to 0.
 */
export function revivePosition(input: unknown): { line: number; character: number } {
  if (typeof input !== 'object' || input === null) {
    return { line: 0, character: 0 };
  }
  const p = input as {
    line?: unknown; character?: unknown;
    _line?: unknown; _character?: unknown;
  };
  // Resolve the spelling first, clamp second. Each coordinate is produced by
  // exactly one guarded expression, so the new `_line`/`_character` path
  // cannot route around the clamp: `_line: -3` resolves to -3, fails the
  // `>= 0` guard, and returns 0 — `new vscode.Position(-3, _)` is never
  // reached (it throws `illegalArgument`, and `gotoSubscriber` calls
  // `reviveRange` outside any try/catch).
  const line = p.line ?? p._line;
  const character = p.character ?? p._character;
  return {
    line: typeof line === 'number' && line >= 0 ? Math.floor(line) : 0,
    character: typeof character === 'number' && character >= 0 ? Math.floor(character) : 0
  };
}

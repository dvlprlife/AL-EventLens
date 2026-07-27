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
 * Three further shapes are tolerated defensively, since a payload can also
 * reach us pre-shaped or structured-cloned rather than JSON-serialized:
 * `{start, end}` (a hand-built or already-JSON-shaped bag), `{_start, _end}`
 * (vscode.Range's internal data slots — the public `start`/`end` are class
 * getters, and accessors are not structured-cloned), and `{}` (nothing
 * useful survived).
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
 * Negative or non-integer coordinates are clamped/floored to a valid value:
 * `vscode.Position`/`Range` throw `illegalArgument` on a negative or
 * non-integer, and `gotoSubscriber` invokes `reviveRange` outside any
 * try/catch, so a malformed structured-cloned payload would otherwise
 * surface a generic error toast instead of this helper's `(0,0)` fallback.
 * `Math.floor` also coerces non-integers; `>= 0` is `false` for `NaN`, so
 * `NaN` falls through to 0.
 */
export function revivePosition(input: unknown): { line: number; character: number } {
  if (typeof input !== 'object' || input === null) {
    return { line: 0, character: 0 };
  }
  const p = input as { line?: unknown; character?: unknown };
  return {
    line: typeof p.line === 'number' && p.line >= 0 ? Math.floor(p.line) : 0,
    character: typeof p.character === 'number' && p.character >= 0 ? Math.floor(p.character) : 0
  };
}

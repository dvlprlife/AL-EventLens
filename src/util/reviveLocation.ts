import * as vscode from 'vscode';

/**
 * Reconstruct a `vscode.Range` from whatever shape arrives at a command
 * handler that was invoked via a webview `postMessage`.
 *
 * vscode.Range exposes `start` / `end` as **class getters** (the data lives
 * in internal `_start` / `_end` slots). The webview `postMessage` channel
 * serializes via structured-clone-like rules that do NOT copy class
 * accessors — so a `vscode.Range` round-tripped through a webview arrives
 * on the host as either `{start, end}` (the JSON-shape some serializers
 * produce), `{_start, _end}` (the internal slots that DO survive cloning),
 * or `{}` (nothing survived). This helper handles all three.
 *
 * Real in-process callers (CodeLens, Tree, anything that runs inside the
 * extension host without a postMessage hop) hand us a true `vscode.Range`
 * instance whose getters work — the `r.start` branch fires immediately.
 *
 * Falls back to `(0, 0)` so `showTextDocument` still opens the file even
 * when position info is fully missing.
 */
export function reviveRange(input: unknown): vscode.Range {
  if (typeof input !== 'object' || input === null) {
    return new vscode.Range(0, 0, 0, 0);
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
 */
export function revivePosition(input: unknown): { line: number; character: number } {
  if (typeof input !== 'object' || input === null) {
    return { line: 0, character: 0 };
  }
  const p = input as { line?: unknown; character?: unknown };
  return {
    line: typeof p.line === 'number' ? p.line : 0,
    character: typeof p.character === 'number' ? p.character : 0
  };
}

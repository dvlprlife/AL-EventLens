import * as vscode from 'vscode';

/** Raw bytes of a `SymbolReference.json` extracted from a `.app` package. */
export interface AppContents {
  readonly appId: string;
  readonly version: string;
  readonly symbolReferenceJson: string;
  /** Bundled AL source files when the package included them under `src/**`. */
  readonly bundledAlSources: ReadonlyArray<{ path: string; text: string }>;
}

/**
 * Read a Business Central `.app` package via `vscode.workspace.fs` and
 * return its parseable contents.
 *
 * The format is a 40-byte **NAVX** header followed by a standard PKZIP
 * archive. The header is stripped and the remainder is decompressed with
 * JSZip (a browser-compatible zip library, required by the VS Code Web
 * runtime).
 *
 * `.NEA` runtime packages are encrypted and unreadable; callers that hand
 * a `.NEA` to this function will receive a clear error rather than a
 * silent failure.
 */
export async function readApp(uri: vscode.Uri): Promise<AppContents> {
  throw new Error(`readApp(${uri.toString()}): not yet implemented`);
}

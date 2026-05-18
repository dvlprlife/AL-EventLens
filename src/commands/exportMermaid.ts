import * as vscode from 'vscode';
import type { Publisher } from '../al/types';
import type { EventIndexStore } from '../index/store';
import { findSubscribersFor } from '../index/match';
import { renderMermaid } from '../ui/mermaid';

/** Subset of `vscode.window` the command handler depends on. Extracted so
 *  tests can pass a fake without spinning up the full window. */
export interface WindowMessageApi {
  showWarningMessage(message: string): Thenable<string | undefined>;
  showInformationMessage(message: string): Thenable<string | undefined>;
  showErrorMessage(message: string): Thenable<string | undefined>;
}

/** Subset of `vscode.env.clipboard` the command handler depends on. */
export interface ClipboardApi {
  writeText(value: string): Thenable<void>;
}

export interface ExportMermaidDeps {
  readonly clipboard: ClipboardApi;
  readonly window: WindowMessageApi;
}

const defaultDeps: ExportMermaidDeps = {
  clipboard: vscode.env.clipboard,
  window: vscode.window
};

/**
 * The body of the `alEventLens.exportMermaid` command. Takes the already-
 * resolved publisher (caller decides arg-or-selection fallback), the store
 * to look up subscribers in, and an optional dependency bag for tests.
 *
 * Resolves once the clipboard write completes (success or failure); never
 * rejects, so callers can chain without `.catch`.
 */
export async function runExportMermaid(
  publisher: Publisher | undefined,
  store: EventIndexStore,
  deps: ExportMermaidDeps = defaultDeps
): Promise<void> {
  if (!publisher) {
    await deps.window.showWarningMessage(
      'AL EventLens: open the panel and select a publisher to export.'
    );
    return;
  }
  const matches = findSubscribersFor(publisher, store.get().subscribers);
  const mermaid = renderMermaid(publisher, matches);
  try {
    await deps.clipboard.writeText(mermaid);
    await deps.window.showInformationMessage(
      `AL EventLens: copied ${matches.length} subscriber${matches.length === 1 ? '' : 's'} to clipboard as Mermaid.`
    );
  } catch (err) {
    console.error('AL EventLens: clipboard write failed', err);
    await deps.window.showErrorMessage(
      'AL EventLens: clipboard write failed; see Extension Host log.'
    );
  }
}

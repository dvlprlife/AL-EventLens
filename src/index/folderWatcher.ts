import * as vscode from 'vscode';
import type { EventIndex } from './indexer';
import { runIndexAndCommit, runIndexWithProgress } from './reindex';
import { EventIndexStore } from './store';

/**
 * Re-run the full index whenever the user adds or removes a workspace
 * folder. Without this, opening a project folder AFTER VS Code has already
 * launched (extension activates against an empty workspace, then folder is
 * added) leaves the index empty until the user manually invokes
 * `AL EventLens: Refresh Index`.
 *
 * `indexFn` is injectable so tests can substitute a synchronous fake
 * without running the real `buildIndex` against a synthetic workspace.
 * Production passes the default — `runIndexWithProgress(context)`. Routes
 * through `runIndexAndCommit` so a folder-change re-index participates in
 * the same last-started-wins ordering as the activation pass and the
 * manual refresh command — a slow folder-change build cannot clobber a
 * faster later-started run.
 */
export function registerWorkspaceFolderReindex(
  context: vscode.ExtensionContext,
  store: EventIndexStore,
  indexFn: () => Promise<EventIndex> = () => runIndexWithProgress(context)
): vscode.Disposable {
  return vscode.workspace.onDidChangeWorkspaceFolders(() => {
    runIndexAndCommit(context, store, () => indexFn()).done
      .catch((err) =>
        console.error('AL EventLens: re-index after workspace folder change failed', err)
      );
  });
}

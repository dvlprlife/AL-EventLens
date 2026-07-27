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
 *
 * **Save-during-rebuild re-issue.** A folder-change rebuild is a full
 * re-scan, so it can take a while, and a `.al` save landing before it
 * finishes supersedes it (the save's generation bump protects its own
 * delta) — leaving the store missing the newly-added folder's files.
 * That recovery is no longer implemented here: it is the shared
 * `RunIndexOptions.reissueIfSuperseded` policy in `reindex.ts`, which
 * this path opts into along with the activation pass and the manual
 * refresh (issue #181). The bespoke per-registration sequence counter
 * this file used to carry is gone; the module-scoped `latestRunSeq` in
 * `reindex.ts` answers the same "has a newer full run started since me?"
 * question for all three callers at once.
 */
export function registerWorkspaceFolderReindex(
  context: vscode.ExtensionContext,
  store: EventIndexStore,
  indexFn: () => Promise<EventIndex> = () => runIndexWithProgress(context)
): vscode.Disposable {
  return vscode.workspace.onDidChangeWorkspaceFolders(() => {
    runIndexAndCommit(context, store, () => indexFn(), { reissueIfSuperseded: true }).done
      .catch((err) =>
        console.error('AL EventLens: re-index after workspace folder change failed', err)
      );
  });
}

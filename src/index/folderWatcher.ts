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
 * re-scan, so it can take a while. If the user saves a `.al` file before
 * it finishes, `handleSave` bumps the started-generation counter to
 * protect its own delta (last-started-wins), which incidentally
 * supersedes this rebuild — its `store.set` is skipped and it resolves
 * `committed: false`. The store then holds `pre-folder index + save
 * delta` but is missing the newly-added folder's files. To close that
 * gap, when the rebuild reports `committed: false` we re-issue exactly
 * one fresh full rebuild; being the newest run it commits, picking up the
 * new folder.
 *
 * Two guards keep this bounded — it cannot loop and cannot pile up behind
 * a newer folder run:
 *   - A closure-scoped `folderChangeSeq` is bumped on every folder change
 *     **and** every re-issue; each run captures its `mySeq`. The re-issue
 *     fires only if `mySeq` is still current, so a *newer* folder change
 *     (which reserves a newer generation and commits on its own) cancels
 *     a stale re-issue rather than racing it (no ping-pong).
 *   - The re-issued run never arms a further re-issue (`reissue` flag), so
 *     the worst case is one rebuild + one re-issue per folder change. A
 *     save-storm during the re-issue degrades to "new folder appears on
 *     the next folder change or manual Refresh" — never an unbounded loop.
 *
 * The generation counter, the save bump, and `runIndexAndCommit`'s commit
 * gate are untouched; this is contained entirely in `folderWatcher.ts`.
 */
export function registerWorkspaceFolderReindex(
  context: vscode.ExtensionContext,
  store: EventIndexStore,
  indexFn: () => Promise<EventIndex> = () => runIndexWithProgress(context)
): vscode.Disposable {
  // Per-registration (NOT module-scoped, so concurrent registrations and
  // repeated test runs don't share state and `resetExtensionStateForReload`
  // semantics in reindex.ts stay untouched). Bumped synchronously before
  // each run starts so a newer folder change is observable as
  // `mySeq !== folderChangeSeq` by an in-flight run's `.then`.
  let folderChangeSeq = 0;

  const issueRebuild = (reissue: boolean): void => {
    folderChangeSeq += 1;
    const mySeq = folderChangeSeq;
    runIndexAndCommit(context, store, () => indexFn()).done
      .then((result) => {
        // Re-issue only when this rebuild was superseded (committed: false)
        // AND no newer folder change / re-issue has happened since (mySeq
        // still current — a bare save does NOT bump folderChangeSeq, which
        // is exactly why a save-supersession re-issues while a newer
        // folder-change supersession is left to commit on its own). The
        // re-issued run passes reissue=true so it never arms another
        // re-issue: one rebuild + one re-issue per folder change, max.
        if (!reissue && result.committed === false && mySeq === folderChangeSeq) {
          issueRebuild(true);
        }
      })
      .catch((err) =>
        console.error('AL EventLens: re-index after workspace folder change failed', err)
      );
  };

  return vscode.workspace.onDidChangeWorkspaceFolders(() => {
    issueRebuild(false);
  });
}

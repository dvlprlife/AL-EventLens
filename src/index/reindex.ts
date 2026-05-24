import * as vscode from 'vscode';
import { buildIndex, type EventIndex } from './indexer';
import type { EventIndexStore } from './store';

/**
 * Run `buildIndex` inside a status-bar progress reporter. Extracted from
 * `extension.ts` so the folder-change watcher and the
 * `alEventLens.refresh` command share one implementation (and so tests can
 * substitute an `indexFn` without simulating the progress UI).
 */
export async function runIndexWithProgress(
  context: vscode.ExtensionContext
): Promise<EventIndex> {
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: 'AL EventLens' },
    async (progress) => buildIndex(context, progress)
  );
}

/**
 * Monotonic generation counter used to drop late-resolving index runs that
 * have been superseded by a newer one. Every entry to `runIndexAndCommit`
 * increments this; the captured value is compared against `latest` just
 * before `store.set` so a slow first-started run cannot overwrite a faster
 * later-started run's result.
 *
 * Module-scoped (not per-store) because there is exactly one active store
 * per extension activation; routing the activation pass, the manual
 * `alEventLens.refresh` command, and the folder-change re-index through
 * one counter is what gives the user "last refresh I asked for wins"
 * semantics regardless of which finishes first.
 */
let latestStartedGeneration = 0;

/**
 * Whether the supplied generation token is still the most-recent one
 * issued. Callers that need to commit an alternative result tied to
 * their original run (e.g. the activation path's empty-index fallback
 * on `indexFn` rejection) consult this before touching the store, so a
 * winning newer run is not clobbered by a loser's failure handler.
 */
export function isLatestGeneration(generation: number): boolean {
  return generation === latestStartedGeneration;
}

/**
 * Build the index and commit the result to the store under
 * last-started-wins ordering. Wraps `runIndexWithProgress` (overridable
 * via `indexFn` for tests).
 *
 * Returns the generation token reserved by this call so a caller can
 * gate its own failure-fallback `store.set` by the same counter via
 * `isLatestGeneration(token)` — see the activation path in
 * `extension.ts`. If another caller increments the counter while this
 * run is in flight, the late result is dropped silently — `store.set`
 * is NOT called on the success path.
 *
 * Errors from `indexFn` propagate to the caller so the existing
 * activation / refresh / folder-change `.catch` paths still log; the
 * generation token is still available because callers reserve it via
 * the synchronous `runIndexAndCommit` entry that returns a `{ done }`
 * promise alongside.
 */
export function runIndexAndCommit(
  context: vscode.ExtensionContext,
  store: EventIndexStore,
  indexFn: (ctx: vscode.ExtensionContext) => Promise<EventIndex> = runIndexWithProgress
): { generation: number; done: Promise<EventIndex> } {
  const generation = ++latestStartedGeneration;
  const done = indexFn(context).then((index) => {
    if (generation === latestStartedGeneration) {
      store.set(index);
    }
    return index;
  });
  return { generation, done };
}

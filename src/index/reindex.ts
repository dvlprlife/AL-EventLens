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
 * Bump the started-generation counter and return the new value. The
 * return value is informational; the side effect — invalidating any
 * in-flight `runIndexAndCommit`'s pending `store.set` whose captured
 * token is now stale — is the point. Called by the save watcher after
 * a successful `store.updateFile` so a buildIndex started before the
 * save cannot overwrite the saved-file delta when it finally resolves.
 */
export function bumpStartedGeneration(): number {
  return ++latestStartedGeneration;
}

/**
 * Module-scoped flag: has ANY `runIndexAndCommit` call successfully
 * committed to the store at least once? Used by the activation path's
 * empty-index fallback so the fallback fires when no build has landed
 * — even if a newer build is currently in flight and its predecessor
 * (this caller) lost the generation race AND threw.
 *
 * Flips to `true` the first time `store.set(index)` actually runs
 * inside `runIndexAndCommit`; never flips back. Stays `false` if every
 * attempt either threw or was superseded.
 */
let anyGenerationCommitted = false;

/**
 * Whether any `runIndexAndCommit` call has committed a built index to
 * the store. The activation path's failure handler uses this — instead
 * of `isLatestGeneration` — to decide whether to install the empty
 * fallback: if no build has committed, the spinner needs to clear; if
 * any build (even one whose generation token was later superseded) has
 * committed, the store already has real data and the fallback would
 * clobber it.
 */
export function hasAnyGenerationCommitted(): boolean {
  return anyGenerationCommitted;
}

/**
 * Test-only: reset the module-scoped `anyGenerationCommitted` flag so
 * tests that exercise the activation-failure path can do so in
 * isolation. Production code MUST NOT call this.
 */
export function resetAnyGenerationCommittedForTesting(): void {
  anyGenerationCommitted = false;
}

/**
 * The shape `runIndexAndCommit`'s `done` promise resolves to: the
 * built index, plus a flag indicating whether THIS run's
 * `store.set(index)` actually ran. `committed: false` means a newer
 * `runIndexAndCommit` (or a save's `bumpStartedGeneration`) bumped the
 * counter past this run's reserved token before it could commit, so
 * the snapshot in `index` was discarded — callers logging or counting
 * on the result should branch on `committed`.
 */
export interface RunIndexResult {
  readonly index: EventIndex;
  readonly committed: boolean;
}

/**
 * Build the index and commit the result to the store under
 * last-started-wins ordering. Wraps `runIndexWithProgress` (overridable
 * via `indexFn` for tests).
 *
 * Returns the generation token reserved by this call so a caller can
 * gate its own failure-fallback `store.set` by the same counter via
 * `isLatestGeneration(token)` — see the activation path in
 * `extension.ts`. If another caller (or `bumpStartedGeneration`)
 * increments the counter while this run is in flight, the late result
 * is dropped silently — `store.set` is NOT called on the success path
 * and `done` resolves with `committed: false`.
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
): { generation: number; done: Promise<RunIndexResult> } {
  const generation = ++latestStartedGeneration;
  const done = indexFn(context).then((index): RunIndexResult => {
    if (generation === latestStartedGeneration) {
      store.set(index);
      anyGenerationCommitted = true;
      return { index, committed: true };
    }
    return { index, committed: false };
  });
  return { generation, done };
}

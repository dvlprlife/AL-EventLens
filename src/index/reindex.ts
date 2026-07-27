/**
 * The vscode-aware index runner: progress reporting, last-started-wins
 * commit ordering, the save-supersession recovery policy, and the three
 * full-pass entry points (activation, `alEventLens.refresh`, and — via
 * `folderWatcher.ts` — workspace-folder change).
 *
 * **Layering.** `src/index/` is otherwise pure, but this module is already
 * carved out of that rule alongside `store.ts` because it drives
 * `vscode.window.withProgress`. The activation pass's error toast
 * (`vscode.window.showErrorMessage`) lives here for the same reason its
 * commit policy does: `npm run compile` overwrites `dist/extension.js`
 * with a self-contained esbuild bundle, so anything exported from
 * `extension.ts` is unreachable from the test host without loading a
 * second, module-state-decoupled copy of this file. Keeping the whole
 * activation/refresh policy in one module under `src/index/` is what makes
 * it testable at all — see the extraction note on `runInitialIndex`.
 */
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
 * Monotonic count of `runIndexAndCommit` entries. Distinct from
 * `latestStartedGeneration`, which `bumpStartedGeneration` (a save's
 * single-file delta) ALSO bumps. That difference is the whole
 * discriminator for the re-issue policy: at the moment a run finds itself
 * superseded, `runSeq === latestRunSeq` means "no newer FULL run exists,
 * so a save delta bumped past me and the full scan I just built is not
 * coming back from anywhere" → re-issue. `runSeq !== latestRunSeq` means
 * "a newer full run took over and will commit on its own" → stand down.
 *
 * Module-scoped for the same reason `latestStartedGeneration` is: there is
 * exactly one active store per activation, and the activation pass, the
 * manual refresh, and the folder-change rebuild must all be visible to
 * each other as "a newer full run".
 */
let latestRunSeq = 0;

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
 *
 * Deliberately does NOT bump `latestRunSeq` — that omission is
 * load-bearing. It is what lets a superseded full run tell "a save delta
 * bumped past me" (re-issue) from "a newer full run bumped past me"
 * (stand down). See `RunIndexOptions.reissueIfSuperseded`.
 */
export function bumpStartedGeneration(): number {
  return ++latestStartedGeneration;
}

/**
 * Reset this module's generation state. Called from `deactivate()` so a
 * subsequent `activate()` (e.g. Developer: Reload Window where the JS
 * module survives) starts from a clean counter rather than inheriting
 * the previous activation's value — which would otherwise let a stale
 * captured token from the prior session masquerade as current.
 *
 * Production code other than `deactivate()` MUST NOT call this; doing so
 * would invalidate every in-flight `runIndexAndCommit`'s captured token
 * at once.
 */
export function resetExtensionStateForReload(): void {
  latestStartedGeneration = 0;
  latestRunSeq = 0;
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
  /**
   * True only when `committed` is false AND this run responded by
   * launching exactly one fresh replacement run (see
   * `RunIndexOptions.reissueIfSuperseded`). Lets callers log "superseded
   * by a save, re-indexing" separately from "superseded by a newer index
   * run, discarding" — the two cases have opposite user-visible
   * consequences and the old single log line conflated them.
   */
  readonly reissued: boolean;
}

/**
 * Per-run policy knobs for `runIndexAndCommit`.
 */
export interface RunIndexOptions {
  /**
   * Opt in to the save-supersession recovery policy. When this run's
   * commit is suppressed by a save's generation bump — and no newer full
   * run has started, which `latestRunSeq` distinguishes — launch exactly
   * one fresh run to replace the discarded scan. The re-issued run is
   * started with this flag OFF, so the worst case is one run + one
   * re-issue, never a rebuild loop.
   *
   * Discarding and re-scanning is correct rather than lossy because
   * `onDidSaveTextDocument` fires *after* the write lands, so the
   * re-issued run re-reads the saved file from disk: the delta that
   * superseded us is re-derived by the replacement scan, not lost.
   *
   * Default `false`, so the primitive's last-started-wins contract is
   * unchanged for any caller that does not ask for recovery.
   */
  readonly reissueIfSuperseded?: boolean;
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
 *
 * With `options.reissueIfSuperseded`, a run whose commit was suppressed
 * by a *save* (rather than by a newer full run) launches exactly one
 * replacement run before resolving — see `RunIndexOptions`. The re-issue
 * is deliberately detached: `done` still resolves with THIS run's result,
 * so callers stay fire-and-forget and the returned `reissued` flag is
 * what tells them which of the two supersession causes applied.
 */
export function runIndexAndCommit(
  context: vscode.ExtensionContext,
  store: EventIndexStore,
  indexFn: (ctx: vscode.ExtensionContext) => Promise<EventIndex> = runIndexWithProgress,
  options: RunIndexOptions = {}
): { generation: number; done: Promise<RunIndexResult> } {
  const generation = ++latestStartedGeneration;
  const runSeq = ++latestRunSeq;
  const done = indexFn(context).then((index): RunIndexResult => {
    if (generation === latestStartedGeneration) {
      store.set(index);
      return { index, committed: true, reissued: false };
    }
    // Superseded. Re-issue only when a save delta — not a newer full run —
    // is what bumped past us, and only when the caller asked for recovery.
    // `runSeq === latestRunSeq` is that test: no other full run has entered
    // since we did, so nothing else is going to rebuild what we just threw
    // away. The replacement is started WITHOUT the flag, so it can never
    // arm another: one run + one re-issue, max.
    if (options.reissueIfSuperseded === true && runSeq === latestRunSeq) {
      runIndexAndCommit(context, store, indexFn).done
        .catch((err) => console.error('AL EventLens: re-issued index run failed', err));
      return { index, committed: false, reissued: true };
    }
    return { index, committed: false, reissued: false };
  });
  return { generation, done };
}

/**
 * The activation-time full index pass — the body of what used to sit
 * inline in `extension.ts`'s `activate()`.
 *
 * Extracted here (rather than exported from `extension.ts`) so the
 * save-supersession recovery policy is exercised by tests against the
 * real production call site: `npm run compile` runs `tsc --outDir dist`
 * and then esbuild, whose node target overwrites `dist/extension.js` with
 * a self-contained bundle — a test importing `../../extension` would load
 * a second copy of this module with its own generation counters, silently
 * decoupled from the copy the same test drives directly. Issue #181 was
 * precisely a call site failing to opt into a policy, so the call site
 * itself has to be what the tests run.
 *
 * On failure the store is still marked initialized (with an empty index)
 * so the tree's `indexing…` placeholder progresses to the real empty-state
 * message rather than spinning forever — but ONLY if NO commit has landed
 * yet. The `store.isInitialized` gate covers BOTH commit paths: a
 * successful `runIndexAndCommit` `store.set` (full pass) AND a successful
 * `handleSave` `store.updateFile` (a save during a slow failing initial).
 * If either has fired, the store already holds real data and the empty
 * fallback would clobber it (issue #119). If BOTH this initial pass AND a
 * refresh fail with no save in between, `store.isInitialized` stays false
 * and the fallback still fires so the spinner clears.
 */
export async function runInitialIndex(
  context: vscode.ExtensionContext,
  store: EventIndexStore,
  indexFn: (ctx: vscode.ExtensionContext) => Promise<EventIndex> = runIndexWithProgress
): Promise<void> {
  try {
    const { index, committed, reissued } = await runIndexAndCommit(
      context, store, indexFn, { reissueIfSuperseded: true }
    ).done;
    if (committed) {
      console.log(`AL EventLens: indexed ${index.publishers.length} publishers, ${index.subscribers.length} subscribers`);
    } else if (reissued) {
      console.log('AL EventLens: initial index superseded by a file save - re-indexing');
    } else {
      console.log('AL EventLens: initial index superseded by a newer index run - discarding this result');
    }
  } catch (err) {
    console.error('AL EventLens: indexing failed', err);
    // Parser-bug errors carry a recognizable marker prefix (see
    // `indexer.ts`); surface them via a toast so the user actually
    // notices and can file an issue. Transient I/O errors stay
    // console-only — they're noisy and usually self-heal.
    if (err instanceof Error && err.message.startsWith('[AL EventLens parser bug]')) {
      void vscode.window.showErrorMessage(
        `AL EventLens: parser bug — please file an issue. ${err.message}`
      );
    }
    if (!store.isInitialized) {
      store.set({ publishers: [], subscribers: [], appMeta: new Map() });
    }
  }
}

/**
 * The `alEventLens.refresh` command body. Extracted alongside
 * `runInitialIndex` for the same reason, and opted into the same
 * save-supersession recovery: Refresh is the user's obvious way to
 * recover from a bad index, so silently discarding it on an overlapping
 * autosave is the worst possible place for that hole (issue #181).
 *
 * Stays silent on success — the user asked for this and sees the store
 * update — and logs only failures and the two supersession outcomes.
 */
export async function runRefreshIndex(
  context: vscode.ExtensionContext,
  store: EventIndexStore,
  indexFn: (ctx: vscode.ExtensionContext) => Promise<EventIndex> = runIndexWithProgress
): Promise<void> {
  try {
    const { committed, reissued } = await runIndexAndCommit(
      context, store, indexFn, { reissueIfSuperseded: true }
    ).done;
    if (!committed && reissued) {
      console.log('AL EventLens: refresh superseded by a file save - re-indexing');
    } else if (!committed) {
      console.log('AL EventLens: refresh superseded by a newer index run - discarding this result');
    }
  } catch (err) {
    console.error('AL EventLens: refresh failed', err);
  }
}

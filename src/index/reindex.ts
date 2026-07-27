/**
 * The vscode-aware index runner: progress reporting, last-started-wins
 * commit ordering, the save-supersession recovery policy, and the three
 * full-pass entry points (activation, `alEventLens.refresh`, and — via
 * `folderWatcher.ts` — workspace-folder change).
 *
 * **Layering.** This module is the one documented exception to the
 * layer-discipline rule in `agents/WORKFLOW.md`: it is the only file under
 * `src/al/`, `src/symbols/`, or `src/index/` permitted to touch
 * `vscode.window`. (`store.ts` imports `vscode` too, but only for
 * `EventEmitter`/`Disposable` — it has no user-facing surface, so it is
 * not an exception to anything.) Both `vscode.window` uses here — the
 * `withProgress` reporter and the activation pass's `showErrorMessage`
 * parser-bug toast — are in this file for one reason: `npm run compile`
 * has esbuild overwrite `dist/extension.js` with a self-contained bundle,
 * so anything exported from `extension.ts` is unreachable from the test
 * host without loading a second, module-state-decoupled copy of this
 * file. Keeping the whole activation/refresh policy in one module under
 * `src/index/` is what makes it testable at all — see the extraction note
 * on `runInitialIndex`.
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
 * Raise the "please file an issue" toast for a parser bug, and only for a
 * parser bug. `indexer.ts` wraps an exception thrown out of `parseAl` in a
 * new Error carrying the `[AL EventLens parser bug]` marker prefix
 * precisely so this check can tell it from a transient I/O failure, which
 * stays console-only — those are noisy and usually self-heal.
 *
 * Shared by the activation pass's own catch and by the detached re-issued
 * run's catch so a failure surfaces identically whichever of the two it
 * lands on.
 */
function surfaceParserBug(err: unknown): void {
  if (err instanceof Error && err.message.startsWith('[AL EventLens parser bug]')) {
    void vscode.window.showErrorMessage(
      `AL EventLens: parser bug — please file an issue. ${err.message}`
    );
  }
}

/**
 * Launch exactly one replacement run for a full scan that was built and
 * then discarded. Started WITHOUT `reissueIfSuperseded`, so a replacement
 * can never arm another — and, because both `rebuildOwed = true`
 * assignments sit inside the same flag-gated block, can never record a
 * debt either. That flag-off argument list is the entire rebuild-loop
 * bound, and it lives here, at the one place a re-issue starts.
 *
 * Detached on purpose: the caller's `done` reports the ORIGINAL run's
 * outcome, so no caller catch covers this one. Its own catch therefore
 * logs AND routes a parser bug through `surfaceParserBug`, or a failure
 * landing here instead of on the original would lose the toast.
 */
function startReissue(
  context: vscode.ExtensionContext,
  store: EventIndexStore,
  indexFn: (ctx: vscode.ExtensionContext) => Promise<EventIndex>
): void {
  runIndexAndCommit(context, store, indexFn).done
    .catch((err) => {
      console.error('AL EventLens: re-issued index run failed', err);
      surfaceParserBug(err);
    });
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
 * "a newer full run took over" → consult that run's OUTCOME before
 * standing down.
 *
 * This counter records *entry* only, and is deliberately monotonic — it is
 * never rolled back, not even when the run that took it rejects. Rolling
 * it back would resurrect a stale value the moment a third run had already
 * entered, silently disabling the save-path re-issue for that third run.
 * `latestCommittedRunSeq` and `latestFailedRunSeq` are what turn entry into
 * outcome; the save branch above is still checked FIRST, before either of
 * them, so a run superseded by a save alone can never reach them (a save
 * does not move this counter, so such a run always satisfies
 * `runSeq === latestRunSeq`).
 *
 * Module-scoped for the same reason `latestStartedGeneration` is: there is
 * exactly one active store per activation, and the activation pass, the
 * manual refresh, and the folder-change rebuild must all be visible to
 * each other as "a newer full run".
 */
let latestRunSeq = 0;

/**
 * `runSeq` of the newest run whose `store.set` actually ran. Only ever
 * moves forward: committing requires `generation === latestStartedGeneration`,
 * and every later `runIndexAndCommit` entry bumps `latestStartedGeneration`,
 * so a committing run always holds `runSeq === latestRunSeq` at commit
 * time. `latestCommittedRunSeq > runSeq` therefore reads exactly as "a
 * strictly newer full run already committed a full scan", which is the one
 * case in which a superseded run owes the workspace nothing at all.
 */
let latestCommittedRunSeq = 0;

/**
 * `runSeq` of the newest run whose `indexFn` rejected. Lets a superseded
 * run distinguish "the newer run that took over is still in flight" (hand
 * the rebuild off to it) from "the newest run has already failed and
 * nothing newer entered behind it" (nobody is left, so rebuild ourselves).
 */
let latestFailedRunSeq = 0;

/**
 * Set by a superseded run that discarded a full scan and handed the
 * rebuild off to the newer run that took over. Discharged when that run
 * commits (its scan *is* the rebuild) or rejects (it re-issues on the
 * superseded run's behalf).
 *
 * Deliberately a boolean, not a count: two superseded runs both owed a
 * rebuild are satisfied by one full scan. The debt is "the store may be
 * missing content", not "N scans are outstanding".
 */
let rebuildOwed = false;

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
 * (consult that run's outcome). See `RunIndexOptions.reissueIfSuperseded`.
 *
 * The asymmetry also keeps a save out of the outcome-tracking state added
 * for issue #195 entirely: because a save leaves `latestRunSeq` alone, a
 * run superseded by a save alone always satisfies `runSeq === latestRunSeq`
 * and takes the first branch in `runIndexAndCommit`, which is checked
 * before `latestCommittedRunSeq` / `latestFailedRunSeq` / `rebuildOwed` are
 * consulted at all. Do not add a `latestRunSeq` bump here.
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
 *
 * Zeroing here is not sufficient on its own: a run that entered BEFORE the
 * reset would otherwise find `latestFailedRunSeq === latestRunSeq`
 * vacuously true (`0 === 0`) and fire a re-issue against a disposed store.
 * The `runSeq > latestRunSeq` early return on both settle handlers in
 * `runIndexAndCommit` is what stops that — see the comment there.
 */
export function resetExtensionStateForReload(): void {
  latestStartedGeneration = 0;
  latestRunSeq = 0;
  latestCommittedRunSeq = 0;
  latestFailedRunSeq = 0;
  rebuildOwed = false;
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
   * `RunIndexOptions.reissueIfSuperseded`). Lets callers log "superseded,
   * re-indexing" separately from "superseded, discarding" — the two cases
   * have opposite user-visible consequences and the old single log line
   * conflated them. It does NOT name the cause: a re-issue follows either
   * a save delta or a newer full run that failed, so a caller's log line
   * must stay cause-neutral.
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
   * The converse — standing down because a newer full run exists — waits
   * on that newer run's *outcome*, not merely its existence: it commits
   * (its scan covers ours, so nothing is owed), or it is still in flight
   * (the rebuild is handed off to it and it re-issues on our behalf if it
   * rejects), or it has already rejected with nothing newer behind it (so
   * this run re-issues itself). Either way exactly one replacement scan
   * results — one run + one re-issue, never a rebuild loop.
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
 * Returns the generation token reserved by this call. Nothing in `src/`
 * consults it any more: the activation path's empty-index fallback
 * (`runInitialIndex`, below) gates on `!store.isInitialized` instead,
 * because gating it on "am I still the latest generation?" is exactly
 * what left the tree spinning forever when an overlapping refresh also
 * failed (issue #113, fixed in #119). The token is still returned
 * because the counter's monotonicity is the contract tests assert on.
 * If another caller (or `bumpStartedGeneration`) increments the counter
 * while this run is in flight, the late result is dropped silently —
 * `store.set` is NOT called on the success path and `done` resolves with
 * `committed: false`.
 *
 * Errors from `indexFn` propagate to the caller so the existing
 * activation / refresh / folder-change `.catch` paths still log; the
 * generation token is still available because callers reserve it via
 * the synchronous `runIndexAndCommit` entry that returns a `{ done }`
 * promise alongside.
 *
 * With `options.reissueIfSuperseded`, a run whose commit was suppressed —
 * by a save delta, or by a newer full run that then failed rather than
 * committing — launches exactly one replacement run before resolving; and
 * a run that supersedes such a run and then rejects itself launches that
 * replacement on its behalf. See `RunIndexOptions`. The re-issue
 * is deliberately detached: `done` still resolves with THIS run's result,
 * so callers stay fire-and-forget and the returned `reissued` flag is
 * what tells them whether the discarded scan is coming back or not (it
 * does NOT name the cause — see `RunIndexResult.reissued`). Because
 * it is detached, no caller catch covers it, so its own catch logs AND
 * routes a parser bug through `surfaceParserBug` — otherwise a failure
 * landing on the re-issue instead of the original would lose the toast.
 */
export function runIndexAndCommit(
  context: vscode.ExtensionContext,
  store: EventIndexStore,
  indexFn: (ctx: vscode.ExtensionContext) => Promise<EventIndex> = runIndexWithProgress,
  options: RunIndexOptions = {}
): { generation: number; done: Promise<RunIndexResult> } {
  const generation = ++latestStartedGeneration;
  const runSeq = ++latestRunSeq;
  // Two handlers, NOT `.then(...).catch(...)`: a throw out of the success
  // handler must not fall into the failure handler and be mistaken for an
  // `indexFn` rejection.
  const done = indexFn(context).then(
    (index): RunIndexResult => {
      if (generation === latestStartedGeneration) {
        store.set(index);
        latestCommittedRunSeq = runSeq;
        // A committed full scan IS the rebuild anyone was owed.
        rebuildOwed = false;
        return { index, committed: true, reissued: false };
      }
      // Superseded. Everything below is bookkeeping for who, if anyone,
      // still owes the workspace a full scan.
      if (runSeq > latestRunSeq) {
        // Only reachable when `resetExtensionStateForReload` ran while we
        // were in flight: `latestRunSeq` is monotonic otherwise. Our token
        // belongs to a previous activation, `store` is disposed, and every
        // counter below is now about a different session — stand down and
        // write nothing. Without this the post-reset `0 === 0` would make
        // `latestFailedRunSeq === latestRunSeq` vacuously true and fire a
        // rebuild against a disposed store.
        return { index, committed: false, reissued: false };
      }
      if (options.reissueIfSuperseded === true) {
        // The three-way decision. `latestRunSeq` records ENTRY, so on its
        // own it answers "did a newer full run start?" when what matters
        // is "will a newer full run commit?" — `latestCommittedRunSeq` and
        // `latestFailedRunSeq` supply the outcome. Do NOT "simplify" this
        // back to a bare existence test: that was the #195 gap, and do not
        // replace it by rolling `latestRunSeq` back either — a third run
        // then inherits a resurrected sequence number. This module's
        // concurrency shortcuts have a history (#113, #119, #181, #195) of
        // costing more than they save.
        if (runSeq === latestRunSeq) {
          // A save delta bumped past us and no newer full run exists, so
          // nothing else is going to rebuild what we just threw away
          // (#181). Checked FIRST: a save never moves `latestRunSeq`, so a
          // save-superseded run never reaches the outcome state below.
          startReissue(context, store, indexFn);
          return { index, committed: false, reissued: true };
        }
        if (latestCommittedRunSeq <= runSeq) {
          // A newer full run entered but none of them has committed.
          if (latestFailedRunSeq === latestRunSeq) {
            // ...and the newest one already failed, with nothing newer
            // behind it. Nobody is left to rebuild, so we do (#195).
            startReissue(context, store, indexFn);
            return { index, committed: false, reissued: true };
          }
          // The newest run is still in flight. Hand the rebuild off: it
          // either commits (clearing this) or, when it rejects, re-issues
          // on our behalf. Re-issuing here instead would race a run that
          // is about to commit — the #113/#119 bug class.
          rebuildOwed = true;
        }
        // else: a strictly newer full run already committed a full scan,
        // so nothing is owed and recording a debt here would make it
        // permanently sticky. Stand down.
        //
        // Residual bound, unchanged in shape from #181: if a debt is owed
        // and the newest run is a flag-off replacement that gets superseded
        // by a SAVE (rather than committing or rejecting), the debt sits
        // until the next full run settles. That is still at most one extra
        // scan, and it matches the "two saves inside the activation window
        // leave the store partial" bound already recorded in the CHANGELOG.
      }
      return { index, committed: false, reissued: false };
    },
    (err: unknown): never => {
      if (runSeq <= latestRunSeq) {
        // Same post-reset guard as the success path: skip all bookkeeping
        // when a reset ran under us, or this run's large stale seq would
        // poison the next activation's counters.
        if (runSeq > latestFailedRunSeq) {
          latestFailedRunSeq = runSeq;
        }
        if (rebuildOwed && runSeq === latestRunSeq) {
          // We superseded a run that discarded its scan for us, and we
          // have nothing to commit. Nothing newer entered, so the debt
          // stops here. Clear it BEFORE starting the replacement: that is
          // what makes each debt discharge exactly once, so a replacement
          // that also fails cannot start a third run.
          rebuildOwed = false;
          console.log('AL EventLens: the index run that superseded an earlier rebuild failed - re-indexing');
          startReissue(context, store, indexFn);
        }
      }
      // Rethrown unmodified: `runInitialIndex`'s empty-index fallback and
      // parser-bug toast, `runRefreshIndex`'s log, `folderWatcher`'s log,
      // and the suite's `assert.rejects` all depend on `done` still
      // rejecting with this exact error.
      throw err;
    }
  );
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
      // Cause-neutral on purpose: `reissued` now covers both a save delta
      // and a newer full run that failed, and naming only the first would
      // be exactly the misleading log line #181 was filed about.
      console.log('AL EventLens: initial index superseded before it could commit - re-indexing');
    } else {
      console.log('AL EventLens: initial index superseded by a newer index run - discarding this result');
    }
  } catch (err) {
    console.error('AL EventLens: indexing failed', err);
    surfaceParserBug(err);
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
      // Cause-neutral: see the matching note in `runInitialIndex`.
      console.log('AL EventLens: refresh superseded before it could commit - re-indexing');
    } else if (!committed) {
      console.log('AL EventLens: refresh superseded by a newer index run - discarding this result');
    }
  } catch (err) {
    console.error('AL EventLens: refresh failed', err);
  }
}

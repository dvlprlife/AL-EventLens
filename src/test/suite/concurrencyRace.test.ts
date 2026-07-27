import * as assert from 'assert';
import * as vscode from 'vscode';
import type { Publisher, Subscriber } from '../../al/types';
import type { EventIndex } from '../../index/indexer';
import {
  resetExtensionStateForReload,
  runIndexAndCommit,
  runInitialIndex,
  runRefreshIndex
} from '../../index/reindex';
import { EventIndexStore } from '../../index/store';
import { handleSave } from '../../index/watcher';
import * as appJson from '../../index/appJson';

// ─── Deferred promise helper ───────────────────────────────────────────
//
// Lets each test orchestrate resolution order explicitly — the whole
// point of these tests is to assert behavior when slow + fast async
// passes interleave, so manual control is required.

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(err: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** Flush the microtask + setImmediate queue so detached promise chains run. */
function flush(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

function makeIndex(label: string): EventIndex {
  const pub: Publisher = {
    owner: { kind: 'codeunit', name: label },
    eventName: 'OnAfterFoo',
    kind: 'integration'
  };
  return { publishers: [pub], subscribers: [], appMeta: new Map() };
}

function fakeContext(): vscode.ExtensionContext {
  return { subscriptions: [] } as unknown as vscode.ExtensionContext;
}

// ─── Tests: runIndexAndCommit last-started-wins ────────────────────────

suite('index/reindex: runIndexAndCommit last-started-wins', () => {
  test('two overlapping runs, FIRST-started resolves LAST — its result is dropped', async () => {
    const store = new EventIndexStore();
    const setCalls: EventIndex[] = [];
    const realSet = store.set.bind(store);
    store.set = (idx: EventIndex): void => {
      setCalls.push(idx);
      realSet(idx);
    };
    try {
      const dA = deferred<EventIndex>();
      const dB = deferred<EventIndex>();

      // Start A first — it reserves an earlier generation.
      const a = runIndexAndCommit(fakeContext(), store, () => dA.promise);
      // Start B next — it reserves a later generation, so it wins regardless
      // of which promise resolves first.
      const b = runIndexAndCommit(fakeContext(), store, () => dB.promise);

      assert.ok(b.generation > a.generation,
        'each start must reserve a strictly newer generation token');

      // Resolve B first (the fast/later-started run completes first).
      const indexB = makeIndex('B');
      dB.resolve(indexB);
      await b.done;

      // Now resolve A — slower/first-started — and assert it does NOT
      // overwrite the store with its stale snapshot.
      const indexA = makeIndex('A');
      dA.resolve(indexA);
      await a.done;

      assert.strictEqual(setCalls.length, 1,
        'only the winner (B) should have called store.set; the loser (A) must be silently dropped');
      assert.strictEqual(setCalls[0], indexB,
        'the committed snapshot must be from the LAST-started run (B), not the first-started one');
      assert.strictEqual(store.get(), indexB,
        'store final state must reflect B, not A');
    } finally {
      store.dispose();
    }
  });

  test('two overlapping runs, sequential resolution in start order — last-started still wins', async () => {
    const store = new EventIndexStore();
    const setCalls: EventIndex[] = [];
    const realSet = store.set.bind(store);
    store.set = (idx: EventIndex): void => {
      setCalls.push(idx);
      realSet(idx);
    };
    try {
      const dA = deferred<EventIndex>();
      const dB = deferred<EventIndex>();
      const a = runIndexAndCommit(fakeContext(), store, () => dA.promise);
      const b = runIndexAndCommit(fakeContext(), store, () => dB.promise);

      // Resolve A first (first-started, resolves first) — it is now
      // already superseded by B's reservation, so A must NOT commit.
      dA.resolve(makeIndex('A'));
      await a.done;
      assert.strictEqual(setCalls.length, 0,
        'A must NOT commit because B has already taken the latest generation');

      // Now resolve B (last-started) — it commits.
      const indexB = makeIndex('B');
      dB.resolve(indexB);
      await b.done;
      assert.strictEqual(setCalls.length, 1);
      assert.strictEqual(setCalls[0], indexB);
      assert.strictEqual(store.get(), indexB);
    } finally {
      store.dispose();
    }
  });

  test('a single non-overlapping run still commits (no regression for the common case)', async () => {
    const store = new EventIndexStore();
    try {
      const idx = makeIndex('solo');
      const r = runIndexAndCommit(fakeContext(), store, async () => idx);
      await r.done;
      assert.strictEqual(store.get(), idx,
        'a non-racing run must commit normally — generation guard is for races only');
      assert.strictEqual(store.isInitialized, true);
    } finally {
      store.dispose();
    }
  });

  test('reissued defaults to false — on a committed run AND on one superseded by a newer full run', async () => {
    // Pins the new `RunIndexResult.reissued` field's default: without the
    // `reissueIfSuperseded` opt-in the primitive's contract is exactly what
    // it was — last-started-wins, loser silently dropped, no replacement run.
    const store = new EventIndexStore();
    try {
      const dA = deferred<EventIndex>();
      const dB = deferred<EventIndex>();
      const a = runIndexAndCommit(fakeContext(), store, () => dA.promise);
      const b = runIndexAndCommit(fakeContext(), store, () => dB.promise);

      dB.resolve(makeIndex('B'));
      const resultB = await b.done;
      assert.strictEqual(resultB.committed, true);
      assert.strictEqual(resultB.reissued, false,
        'a run that commits never re-issues');

      dA.resolve(makeIndex('A'));
      const resultA = await a.done;
      assert.strictEqual(resultA.committed, false);
      assert.strictEqual(resultA.reissued, false,
        'without the opt-in flag a superseded run must NOT re-issue');
    } finally {
      store.dispose();
    }
  });
});

// ─── Tests: handleSave per-URI generation guard ────────────────────────

interface ConfigPatches {
  indexOnSave?: boolean;
  includeTriggerEvents?: boolean;
}

let originalGetConfig: typeof vscode.workspace.getConfiguration;
let originalDiscoverWorkspaceApps: typeof appJson.discoverWorkspaceApps;

function patchConfig(p: ConfigPatches): void {
  originalGetConfig = vscode.workspace.getConfiguration;
  Object.defineProperty(vscode.workspace, 'getConfiguration', {
    configurable: true,
    value: (section?: string): vscode.WorkspaceConfiguration => {
      if (section !== 'alEventLens') {
        return originalGetConfig.call(vscode.workspace, section);
      }
      const stub: Partial<vscode.WorkspaceConfiguration> = {
        get: <T>(key: string, defaultValue?: T): T => {
          if (key === 'indexOnSave') {
            return (p.indexOnSave ?? true) as unknown as T;
          }
          if (key === 'includeTriggerEvents') {
            return (p.includeTriggerEvents ?? false) as unknown as T;
          }
          return defaultValue as T;
        },
        has: (): boolean => true,
        inspect: (): undefined => undefined,
        update: async (): Promise<void> => undefined
      };
      return stub as vscode.WorkspaceConfiguration;
    }
  });
}

function restoreConfig(): void {
  if (originalGetConfig) {
    Object.defineProperty(vscode.workspace, 'getConfiguration', {
      configurable: true,
      value: originalGetConfig
    });
  }
}

function patchDiscoverApps(impl: () => Promise<unknown>): void {
  originalDiscoverWorkspaceApps = appJson.discoverWorkspaceApps;
  // The exported binding is read-only in ES modules but writable on the
  // compiled CommonJS object, which is what `require` returns at test time.
  (appJson as { discoverWorkspaceApps: typeof appJson.discoverWorkspaceApps }).discoverWorkspaceApps =
    impl as typeof appJson.discoverWorkspaceApps;
}

function restoreDiscoverApps(): void {
  if (originalDiscoverWorkspaceApps) {
    (appJson as { discoverWorkspaceApps: typeof appJson.discoverWorkspaceApps }).discoverWorkspaceApps =
      originalDiscoverWorkspaceApps;
  }
}

function fakeDoc(uri: vscode.Uri, text: string): vscode.TextDocument {
  return {
    uri,
    languageId: 'al',
    getText: () => text
  } as unknown as vscode.TextDocument;
}

interface UpdateCall {
  readonly uri: vscode.Uri;
  readonly publishers: ReadonlyArray<Publisher>;
  readonly subscribers: ReadonlyArray<Subscriber>;
}

class RecordingStore extends EventIndexStore {
  public readonly calls: UpdateCall[] = [];
  public override updateFile(
    uri: vscode.Uri,
    publishers: ReadonlyArray<Publisher>,
    subscribers: ReadonlyArray<Subscriber>
  ): void {
    this.calls.push({ uri, publishers, subscribers });
    super.updateFile(uri, publishers, subscribers);
  }
}

// Distinguishable AL bodies so we can tell which save's parse landed in
// the store by the publisher's event name.
const AL_A = [
  'codeunit 50100 "Cu A"',
  '{',
  '    [IntegrationEvent(false, false)]',
  '    procedure OnEventA()',
  '    begin',
  '    end;',
  '}'
].join('\n');

const AL_B = [
  'codeunit 50100 "Cu B"',
  '{',
  '    [IntegrationEvent(false, false)]',
  '    procedure OnEventB()',
  '    begin',
  '    end;',
  '}'
].join('\n');

suite('index/watcher: handleSave per-URI race coalescing', () => {
  teardown(() => { restoreConfig(); restoreDiscoverApps(); });

  test('two overlapping saves of the same URI: only the LAST-started commits', async () => {
    patchConfig({});
    const uri = vscode.Uri.parse('file:///workspace/MyCodeunit.al');

    // Two deferreds so we can flip discoverWorkspaceApps's resolution
    // order. Save-A starts first and we make it resolve LAST — its
    // (stale) snapshot must NOT commit.
    const dA = deferred<unknown[]>();
    const dB = deferred<unknown[]>();
    const calls: Array<'A' | 'B'> = [];
    patchDiscoverApps(async () => {
      // The save that called us is whichever one hasn't been "claimed"
      // yet; we serve A's deferred first, then B's, by call order.
      const which = calls.length === 0 ? 'A' : 'B';
      calls.push(which);
      return (await (which === 'A' ? dA.promise : dB.promise)) as unknown as never;
    });

    const store = new RecordingStore();
    try {
      const saveA = handleSave(fakeDoc(uri, AL_A), store);
      const saveB = handleSave(fakeDoc(uri, AL_B), store);

      // Resolve B first (the later-started save completes first).
      dB.resolve([]);
      await saveB;
      // Now resolve A (earlier-started, stale).
      dA.resolve([]);
      await saveA;

      assert.strictEqual(store.calls.length, 1,
        `only the winner (B) should have committed; got ${store.calls.length} updates`);
      const committedEventNames = store.calls[0].publishers.map((p) => p.eventName);
      assert.ok(committedEventNames.includes('OnEventB'),
        `committed snapshot must be from save-B (OnEventB), got [${committedEventNames.join(', ')}]`);
      assert.ok(!committedEventNames.includes('OnEventA'),
        `save-A's (stale) snapshot must NOT have landed; got [${committedEventNames.join(', ')}]`);
    } finally {
      store.dispose();
    }
  });

  test('two overlapping saves of DIFFERENT URIs both commit — no cross-URI coalescing', async () => {
    patchConfig({});
    const uriA = vscode.Uri.parse('file:///workspace/Aaa.al');
    const uriB = vscode.Uri.parse('file:///workspace/Bbb.al');

    const dA = deferred<unknown[]>();
    const dB = deferred<unknown[]>();
    const callOrder: vscode.Uri[] = [];
    // discoverWorkspaceApps isn't given the URI by handleSave, but the
    // saves call it in the order they enter the await, which is the same
    // order we kicked them off — A first, then B.
    patchDiscoverApps(async () => {
      const which = callOrder.length;
      callOrder.push(uriA);
      return (await (which === 0 ? dA.promise : dB.promise)) as unknown as never;
    });

    const store = new RecordingStore();
    try {
      const saveA = handleSave(fakeDoc(uriA, AL_A), store);
      const saveB = handleSave(fakeDoc(uriB, AL_B), store);

      // Resolve B first, then A — different URIs must not coalesce
      // against each other, so BOTH must commit.
      dB.resolve([]);
      await saveB;
      dA.resolve([]);
      await saveA;

      assert.strictEqual(store.calls.length, 2,
        'different URIs must each get their own updateFile commit');
      const urisCommitted = store.calls.map((c) => c.uri.toString()).sort();
      assert.deepStrictEqual(urisCommitted, [uriA.toString(), uriB.toString()].sort(),
        'both URIs must appear in store.updateFile commits');
    } finally {
      store.dispose();
    }
  });

  test('three rapid same-URI saves: only the LAST-started commits regardless of resolution order', async () => {
    patchConfig({});
    const uri = vscode.Uri.parse('file:///workspace/Triple.al');

    const d1 = deferred<unknown[]>();
    const d2 = deferred<unknown[]>();
    const d3 = deferred<unknown[]>();
    let idx = 0;
    patchDiscoverApps(async () => {
      const which = idx++;
      const d = which === 0 ? d1 : which === 1 ? d2 : d3;
      return (await d.promise) as unknown as never;
    });

    const AL_3 = [
      'codeunit 50100 "Cu Third"',
      '{',
      '    [IntegrationEvent(false, false)]',
      '    procedure OnEventThird()',
      '    begin',
      '    end;',
      '}'
    ].join('\n');

    const store = new RecordingStore();
    try {
      const s1 = handleSave(fakeDoc(uri, AL_A), store);
      const s2 = handleSave(fakeDoc(uri, AL_B), store);
      const s3 = handleSave(fakeDoc(uri, AL_3), store);

      // Resolve in shuffled order: 2, 1, 3. The last-started (s3) must
      // be the only commit, regardless of which order the awaits unblock.
      d2.resolve([]);
      await s2;
      d1.resolve([]);
      await s1;
      d3.resolve([]);
      await s3;

      assert.strictEqual(store.calls.length, 1,
        `only the LAST-started save (s3) should commit; got ${store.calls.length}`);
      const eventNames = store.calls[0].publishers.map((p) => p.eventName);
      assert.ok(eventNames.includes('OnEventThird'),
        `committed snapshot must be from s3 (OnEventThird), got [${eventNames.join(', ')}]`);
    } finally {
      store.dispose();
    }
  });
});

// ─── Tests: generation-guard regression fixes (issue #113) ──────────────
//
// These four tests cover the post-#104 defects: spinner-forever when
// both initial and refresh fail, save-vs-rebuild overwrite, and the
// `done` promise reporting counts for a discarded snapshot.

suite('index/reindex: generation-guard regression fixes', () => {
  teardown(() => {
    restoreConfig();
    restoreDiscoverApps();
  });

  test('initial fails with no overlapping refresh: store still initialized via empty fallback', async () => {
    // This is the baseline guard for the activation path's failure
    // handler — the behavior PR #104 was meant to preserve.
    const store = new EventIndexStore();
    try {
      assert.strictEqual(store.isInitialized, false,
        'precondition: no run has committed yet');

      // Simulate the activation path: kick off a failing run.
      const initial = runIndexAndCommit(
        fakeContext(),
        store,
        async () => { throw new Error('initial boom'); }
      );

      // Mirror extension.ts's failure handler: empty-index fallback
      // gated on `!store.isInitialized` (post #119).
      await initial.done.catch(() => {
        if (!store.isInitialized) {
          store.set({ publishers: [], subscribers: [], appMeta: new Map() });
        }
      });

      assert.strictEqual(store.isInitialized, true,
        'store must be initialized so the tree spinner clears');
      assert.strictEqual(store.get().publishers.length, 0,
        'fallback installs an empty index');
    } finally {
      store.dispose();
    }
  });

  test('initial fails AFTER an overlapping refresh ALSO fails: store still initialized (defect 1)', async () => {
    // Defect 1 (issue #113): post-#104, the activation gate used
    // `isLatestGeneration` (a helper since removed as dead code), so a
    // refresh that overlapped the initial pass took ownership of the
    // latest generation — and when the
    // refresh later FAILED (only logged, no fallback), the initial's
    // failure handler ALSO refused to install the empty fallback
    // because its generation was no longer "latest". Result: store
    // never initialized, spinner forever. Post #119 the gate is
    // `!store.isInitialized`, which is still `true` when both fail.
    const store = new EventIndexStore();
    try {
      const dInitial = deferred<EventIndex>();
      const dRefresh = deferred<EventIndex>();

      // Kick off the initial pass (gen 1).
      const initial = runIndexAndCommit(
        fakeContext(),
        store,
        () => dInitial.promise
      );
      // Kick off a refresh that overlaps it (gen 2 — takes latest).
      const refresh = runIndexAndCommit(
        fakeContext(),
        store,
        () => dRefresh.promise
      );

      // Both fail. The refresh failure (matching extension.ts's refresh
      // handler) only logs; the initial failure runs the empty-fallback
      // gate.
      const refreshCaught = refresh.done.catch(() => undefined);
      dRefresh.reject(new Error('refresh boom'));
      await refreshCaught;

      dInitial.reject(new Error('initial boom'));
      await initial.done.catch(() => {
        if (!store.isInitialized) {
          store.set({ publishers: [], subscribers: [], appMeta: new Map() });
        }
      });

      assert.strictEqual(store.isInitialized, true,
        'when BOTH fail, the fallback must still fire so the spinner clears');
      assert.strictEqual(store.get().publishers.length, 0,
        'fallback installs an empty index');
    } finally {
      store.dispose();
    }
  });

  test('initial REJECTS after a save committed during it: save delta survives the empty fallback (issue #119 defect 1)', async () => {
    // Issue #119 defect 1: the `hasAnyGenerationCommitted` gate was
    // flipped only by `runIndexAndCommit`, not by `handleSave`. So a
    // save that landed during a slow initial pass DID commit (setting
    // `store.isInitialized = true` and seeding real publishers) but
    // left the flag false — and when the initial pass then rejected,
    // the empty-index fallback fired and wiped the saved delta.
    //
    // The fix gates on `!store.isInitialized` instead, which covers
    // both commit paths. This test simulates a save committing during
    // a failing initial pass and asserts the save's publishers survive.
    patchConfig({});
    patchDiscoverApps(async () => []);
    const store = new EventIndexStore();
    try {
      const dInitial = deferred<EventIndex>();
      const initial = runIndexAndCommit(
        fakeContext(),
        store,
        () => dInitial.promise
      );

      // A save lands while the initial pass is still in flight.
      const uri = vscode.Uri.parse('file:///workspace/SavedDuringFailingInitial.al');
      await handleSave(fakeDoc(uri, AL_A), store);

      assert.strictEqual(store.isInitialized, true,
        'save must initialize the store via `updateFile`');
      const namesAfterSave = store.get().publishers.map((p) => p.eventName);
      assert.ok(namesAfterSave.includes('OnEventA'),
        `save's parse must be in the store; got [${namesAfterSave.join(', ')}]`);

      // Now reject the initial pass. The fallback used to fire because
      // `hasAnyGenerationCommitted()` was still false; the new gate
      // `!store.isInitialized` is false, so the fallback is suppressed
      // and the save's delta survives.
      dInitial.reject(new Error('initial boom'));
      await initial.done.catch(() => {
        if (!store.isInitialized) {
          store.set({ publishers: [], subscribers: [], appMeta: new Map() });
        }
      });

      const finalNames = store.get().publishers.map((p) => p.eventName);
      assert.ok(finalNames.includes('OnEventA'),
        `save delta must survive the failing initial; got [${finalNames.join(', ')}]`);
      assert.ok(finalNames.length > 0,
        'store must NOT have been wiped to an empty index by the fallback');
    } finally {
      store.dispose();
    }
  });

  test('overlapping refresh succeeds: superseded initial resolves with committed: false (defect 4)', async () => {
    // Defect 4: when `store.set` is skipped because a newer run won,
    // `runIndexAndCommit`'s `done` resolved with the (discarded) index,
    // so `extension.ts`'s log line printed publisher/subscriber counts
    // for a snapshot that never landed in the store. The new
    // `{ index, committed }` shape lets callers tell.
    const store = new EventIndexStore();
    try {
      const dInitial = deferred<EventIndex>();
      const dRefresh = deferred<EventIndex>();

      const initial = runIndexAndCommit(
        fakeContext(),
        store,
        () => dInitial.promise
      );
      const refresh = runIndexAndCommit(
        fakeContext(),
        store,
        () => dRefresh.promise
      );

      // Refresh commits first — it has the newer generation.
      dRefresh.resolve(makeIndex('refresh'));
      const refreshResult = await refresh.done;
      assert.strictEqual(refreshResult.committed, true,
        'refresh wins its own generation race so it commits');

      // Initial resolves later; its generation token is stale, so its
      // store.set is suppressed and `committed` reports false.
      dInitial.resolve(makeIndex('initial'));
      const initialResult = await initial.done;
      assert.strictEqual(initialResult.committed, false,
        'superseded initial must report committed: false so the log line can branch');
      assert.strictEqual(initialResult.index.publishers[0].owner.name, 'initial',
        'the index field still carries the built (but discarded) snapshot for diagnostics');

      assert.strictEqual(store.get().publishers[0].owner.name, 'refresh',
        'the store reflects the refresh, not the superseded initial');
    } finally {
      store.dispose();
    }
  });

  test('handleSave during an in-flight buildIndex: save survives, rebuild commit is suppressed (defect 2)', async () => {
    // Defect 2: `latestSaveGeneration` (per-URI, in watcher.ts) and
    // `latestStartedGeneration` (module-scoped, in reindex.ts) were
    // independent counters. A buildIndex started before a save would
    // resolve after the save, and its `store.set(staleIndex)` would
    // overwrite the saved-file delta — wiping the entire store back to
    // a pre-save snapshot.
    //
    // The fix: after a successful `store.updateFile` in `handleSave`,
    // bump the started-generation counter so any in-flight buildIndex's
    // captured token is now stale and its commit is skipped.
    patchConfig({});
    patchDiscoverApps(async () => []);

    const store = new RecordingStore();
    try {
      const dRebuild = deferred<EventIndex>();
      // Kick off a buildIndex that won't resolve until we explicitly
      // resolve `dRebuild` — simulates a slow full re-index.
      const rebuild = runIndexAndCommit(
        fakeContext(),
        store,
        () => dRebuild.promise
      );

      // A save lands during the rebuild and commits its delta.
      const uri = vscode.Uri.parse('file:///workspace/SavedDuringRebuild.al');
      await handleSave(fakeDoc(uri, AL_A), store);

      assert.strictEqual(store.calls.length, 1,
        'the save must have committed its delta via updateFile');
      const afterSavePublishers = store.calls[0].publishers.map((p) => p.eventName);
      assert.ok(afterSavePublishers.includes('OnEventA'),
        `save's parsed publishers must be in the store; got [${afterSavePublishers.join(', ')}]`);

      // Now resolve the rebuild. Its `store.set` MUST be suppressed
      // because the save's `bumpStartedGeneration` invalidated its
      // captured token.
      const rebuildIndex = makeIndex('stale-rebuild');
      dRebuild.resolve(rebuildIndex);
      const rebuildResult = await rebuild.done;

      assert.strictEqual(rebuildResult.committed, false,
        'rebuild that started before the save must report committed: false after the bump');

      // The store must still reflect the save's delta — not the stale
      // rebuild's snapshot.
      const finalEventNames = store.get().publishers.map((p) => p.eventName);
      assert.ok(finalEventNames.includes('OnEventA'),
        `store must retain the save's OnEventA delta; got [${finalEventNames.join(', ')}]`);
      assert.ok(!finalEventNames.some((n) => n === 'OnAfterFoo'),
        `stale rebuild's OnAfterFoo must NOT have landed; got [${finalEventNames.join(', ')}]`);
    } finally {
      store.dispose();
    }
  });
});

// ─── Tests: save-supersession re-issue on the activation and refresh
// paths (issue #181) ────────────────────────────────────────────────────
//
// The activation pass and `alEventLens.refresh` both build the FULL index
// and both were superseded — silently, with no recovery — by any `.al`
// save that landed while they were in flight, leaving the store holding
// nothing but that one file's records. These drive the real handler
// bodies (`runInitialIndex` / `runRefreshIndex`, extracted into
// `reindex.ts` precisely so they are reachable from the test host), not a
// re-derived copy of them.

/** A full-workspace snapshot: more than the single saved file's records. */
function makeFullIndex(): EventIndex {
  return {
    publishers: [
      { owner: { kind: 'codeunit', name: 'Cu A' }, eventName: 'OnEventA', kind: 'integration' },
      { owner: { kind: 'codeunit', name: 'Cu B' }, eventName: 'OnEventB', kind: 'integration' }
    ],
    subscribers: [],
    appMeta: new Map()
  };
}

suite('index/reindex: save-supersession re-issue (issue #181)', () => {
  teardown(() => { restoreConfig(); restoreDiscoverApps(); });

  test('a save during the initial activation index re-issues a build that commits the full index', async () => {
    patchConfig({});
    patchDiscoverApps(async () => []);
    const store = new EventIndexStore();
    try {
      const deferreds: Array<Deferred<EventIndex>> = [];
      let calls = 0;
      const indexFn = (): Promise<EventIndex> => {
        calls++;
        const d = deferred<EventIndex>();
        deferreds.push(d);
        return d.promise;
      };

      const initial = runInitialIndex(fakeContext(), store, indexFn);
      await flush();
      assert.strictEqual(calls, 1, 'activation must start exactly one full index');

      // A save lands mid-flight. `handleSave` commits its one-file delta
      // and bumps the started-generation counter to protect it — which
      // incidentally supersedes the in-flight full pass.
      const uri = vscode.Uri.parse('file:///workspace/SavedDuringInitial.al');
      await handleSave(fakeDoc(uri, AL_A), store);

      // Resolve the initial pass: its commit is suppressed, so it must
      // re-issue exactly one fresh full build.
      deferreds[0].resolve(makeIndex('discarded-initial'));
      await initial;
      await flush();
      assert.strictEqual(calls, 2,
        'an initial index superseded by a save must re-issue exactly one fresh build');

      // The re-issued build is newest, so it commits the whole workspace.
      const fullIndex = makeFullIndex();
      deferreds[1].resolve(fullIndex);
      await flush();

      assert.strictEqual(store.get(), fullIndex,
        'the re-issued build must commit the full index');
      const names = store.get().publishers.map((p) => p.eventName);
      assert.ok(names.length > 1,
        `the store must NOT be left holding only the saved file's records; got [${names.join(', ')}]`);
      assert.ok(names.includes('OnEventB'),
        `a publisher from outside the saved file must be present; got [${names.join(', ')}]`);
    } finally {
      store.dispose();
    }
  });

  test('a save during alEventLens.refresh re-issues a build that commits the full index', async () => {
    // Refresh is the user's obvious recovery from a bad index, and it had
    // the identical hole — so a steady autosave cadence could defeat
    // repeated manual attempts.
    patchConfig({});
    patchDiscoverApps(async () => []);
    const store = new EventIndexStore();
    try {
      const deferreds: Array<Deferred<EventIndex>> = [];
      let calls = 0;
      const indexFn = (): Promise<EventIndex> => {
        calls++;
        const d = deferred<EventIndex>();
        deferreds.push(d);
        return d.promise;
      };

      const refresh = runRefreshIndex(fakeContext(), store, indexFn);
      await flush();
      assert.strictEqual(calls, 1, 'refresh must start exactly one full index');

      const uri = vscode.Uri.parse('file:///workspace/SavedDuringRefresh.al');
      await handleSave(fakeDoc(uri, AL_A), store);

      deferreds[0].resolve(makeIndex('discarded-refresh'));
      await refresh;
      await flush();
      assert.strictEqual(calls, 2,
        'a refresh superseded by a save must re-issue exactly one fresh build');

      const fullIndex = makeFullIndex();
      deferreds[1].resolve(fullIndex);
      await flush();

      assert.strictEqual(store.get(), fullIndex,
        'the re-issued refresh must commit the full index');
      assert.ok(store.get().publishers.length > 1,
        'the store must NOT be left holding only the saved file\'s records');
    } finally {
      store.dispose();
    }
  });

  test('a genuinely newer full run supersedes the initial pass WITHOUT re-issuing', async () => {
    // The discriminator: `bumpStartedGeneration` (a save) does not bump
    // `latestRunSeq`, but a second full run does. A superseded run that
    // sees a newer full run stands down — re-issuing here would be the
    // #113 / #119 last-started-wins bug class all over again.
    const store = new EventIndexStore();
    try {
      let calls = 0;
      const dInitial = deferred<EventIndex>();
      const dRefresh = deferred<EventIndex>();

      const initial = runInitialIndex(fakeContext(), store, () => {
        calls++;
        return dInitial.promise;
      });
      const refresh = runRefreshIndex(fakeContext(), store, () => {
        calls++;
        return dRefresh.promise;
      });
      await flush();
      assert.strictEqual(calls, 2, 'two callers start two runs');

      // The refresh owns the newest generation, so it commits.
      const refreshIndex = makeIndex('refresh');
      dRefresh.resolve(refreshIndex);
      await refresh;
      assert.strictEqual(store.get(), refreshIndex, 'the newer full run commits');

      // The initial pass now resolves superseded — but by a full run, not
      // a save, so it must NOT re-issue.
      dInitial.resolve(makeIndex('initial'));
      await initial;
      await flush();

      assert.strictEqual(calls, 2,
        'a run superseded by a NEWER FULL RUN must NOT re-issue (that run already commits)');
      assert.strictEqual(store.get(), refreshIndex,
        'the store still reflects the newer run');
    } finally {
      store.dispose();
    }
  });

  test('at most one re-issue: a save during the re-issued build does not arm a third', async () => {
    // The re-issued run is started with the flag OFF, so a save storm
    // degrades to "the index catches up on the next save or Refresh" —
    // never an unbounded rebuild loop.
    patchConfig({});
    patchDiscoverApps(async () => []);
    const store = new EventIndexStore();
    try {
      const deferreds: Array<Deferred<EventIndex>> = [];
      let calls = 0;
      const indexFn = (): Promise<EventIndex> => {
        calls++;
        const d = deferred<EventIndex>();
        deferreds.push(d);
        return d.promise;
      };

      const initial = runInitialIndex(fakeContext(), store, indexFn);
      await flush();

      // Save #1 supersedes build #1 → one re-issue.
      await handleSave(fakeDoc(vscode.Uri.parse('file:///workspace/Loop1.al'), AL_A), store);
      deferreds[0].resolve(makeIndex('discarded-1'));
      await initial;
      await flush();
      assert.strictEqual(calls, 2, 'the first supersession re-issues once');

      // Save #2 supersedes the RE-ISSUED build #2 → no further re-issue.
      await handleSave(fakeDoc(vscode.Uri.parse('file:///workspace/Loop2.al'), AL_B), store);
      deferreds[1].resolve(makeIndex('discarded-2'));
      await flush();
      await flush();

      assert.strictEqual(calls, 2,
        'the re-issued build must NOT arm a further re-issue — no rebuild loop');
    } finally {
      store.dispose();
    }
  });

  test('the superseded log names its consequence: re-indexing vs discarding', async () => {
    // Issue #181's second half: the old line read "initial build
    // superseded - using newer index" in BOTH cases, which was actively
    // misleading — on the save path no newer index existed at all.
    //
    // The line names the CONSEQUENCE, not the cause. It said "a file save"
    // until #195 gave `reissued: true` a second cause (a superseding run
    // that failed), which would have made that wording newly false — the
    // same defect #181 was filed about. The assertions below are unchanged;
    // only this title and the wording under test moved to be cause-neutral.
    patchConfig({});
    patchDiscoverApps(async () => []);
    const originalConsoleLog = console.log;
    const logs: string[] = [];
    Object.defineProperty(console, 'log', {
      configurable: true,
      writable: true,
      value: (...args: unknown[]): void => { logs.push(args.map((a) => String(a)).join(' ')); }
    });
    const store = new EventIndexStore();
    try {
      // (a) superseded by a SAVE.
      const deferreds: Array<Deferred<EventIndex>> = [];
      const indexFn = (): Promise<EventIndex> => {
        const d = deferred<EventIndex>();
        deferreds.push(d);
        return d.promise;
      };
      const initial = runInitialIndex(fakeContext(), store, indexFn);
      await flush();
      await handleSave(fakeDoc(vscode.Uri.parse('file:///workspace/LogA.al'), AL_A), store);
      deferreds[0].resolve(makeIndex('discarded'));
      await initial;
      await flush();

      assert.ok(logs.some((l) => l.includes('re-indexing')),
        `save-supersession must log that it is re-indexing; got ${JSON.stringify(logs)}`);
      assert.ok(!logs.some((l) => l.includes('using newer index')),
        `the misleading "using newer index" wording must be gone; got ${JSON.stringify(logs)}`);

      // Settle the re-issued build so it does not bleed into part (b).
      deferreds[1].resolve(makeIndex('reissued'));
      await flush();

      // (b) superseded by a NEWER FULL RUN.
      logs.length = 0;
      const dInitial = deferred<EventIndex>();
      const dRefresh = deferred<EventIndex>();
      const initial2 = runInitialIndex(fakeContext(), store, () => dInitial.promise);
      const refresh2 = runRefreshIndex(fakeContext(), store, () => dRefresh.promise);
      dRefresh.resolve(makeIndex('newer'));
      await refresh2;
      dInitial.resolve(makeIndex('older'));
      await initial2;
      await flush();

      assert.ok(logs.some((l) => l.includes('discarding')),
        `newer-run supersession must log that the result is discarded; got ${JSON.stringify(logs)}`);
      assert.ok(!logs.some((l) => l.includes('re-indexing')),
        `newer-run supersession must NOT claim a re-index; got ${JSON.stringify(logs)}`);
      assert.ok(!logs.some((l) => l.includes('using newer index')),
        `the misleading "using newer index" wording must be gone; got ${JSON.stringify(logs)}`);
    } finally {
      Object.defineProperty(console, 'log', {
        configurable: true,
        writable: true,
        value: originalConsoleLog
      });
      store.dispose();
    }
  });

  test('a parser bug in the RE-ISSUED run still raises the toast (the re-issue is detached, so no caller catch covers it)', async () => {
    // The re-issued run is fire-and-forget: `done` resolves with the
    // ORIGINAL run's result, so `runInitialIndex`'s own catch never sees
    // the replacement's rejection. Without routing it through the shared
    // `surfaceParserBug`, a `[AL EventLens parser bug]` landing on the
    // re-issue instead of the original would be console-only and the user
    // would never learn the index failed.
    patchConfig({});
    patchDiscoverApps(async () => []);
    const errors: string[] = [];
    const toasts: string[] = [];
    const originalConsoleError = console.error;
    Object.defineProperty(console, 'error', {
      configurable: true,
      writable: true,
      value: (...args: unknown[]): void => { errors.push(args.map((a) => String(a)).join(' ')); }
    });
    const originalShowError = vscode.window.showErrorMessage;
    Object.defineProperty(vscode.window, 'showErrorMessage', {
      configurable: true,
      value: (text: string): Thenable<string | undefined> => {
        toasts.push(text);
        return Promise.resolve(undefined);
      }
    });
    const store = new EventIndexStore();
    try {
      const deferreds: Array<Deferred<EventIndex>> = [];
      const indexFn = (): Promise<EventIndex> => {
        const d = deferred<EventIndex>();
        deferreds.push(d);
        return d.promise;
      };

      const initial = runInitialIndex(fakeContext(), store, indexFn);
      await flush();

      // A save supersedes the activation pass, arming the re-issue.
      await handleSave(fakeDoc(vscode.Uri.parse('file:///workspace/ToastA.al'), AL_A), store);
      deferreds[0].resolve(makeIndex('discarded'));
      await initial;
      await flush();
      assert.strictEqual(deferreds.length, 2, 'the supersession must have re-issued one run');
      assert.strictEqual(toasts.length, 0,
        'no toast yet — the original run succeeded, it was only superseded');

      // The RE-ISSUED run is the one that hits the parser bug.
      deferreds[1].reject(new Error('[AL EventLens parser bug] boom (in Broken.al)'));
      await flush();

      assert.strictEqual(toasts.length, 1,
        `the re-issued run's parser bug must raise exactly one toast; got ${JSON.stringify(toasts)}`);
      assert.ok(toasts[0].includes('parser bug') && toasts[0].includes('file an issue'),
        `the toast must be the file-an-issue parser-bug message; got ${JSON.stringify(toasts)}`);
      assert.ok(errors.some((e) => e.includes('re-issued index run failed')),
        `the rejection must still be logged; got ${JSON.stringify(errors)}`);
    } finally {
      Object.defineProperty(vscode.window, 'showErrorMessage', {
        configurable: true,
        value: originalShowError
      });
      Object.defineProperty(console, 'error', {
        configurable: true,
        writable: true,
        value: originalConsoleError
      });
      store.dispose();
    }
  });

  test('a run superseded by a newer full run that then FAILS re-issues exactly once (issue #195)', async () => {
    // ORDERING (i) of issue #195: the superseding run rejects BEFORE the
    // superseded run resolves, so the superseded run is still in flight
    // and can observe the failure at its own resolution point. The mirror
    // ordering — the superseded run stands down first and the superseder
    // fails afterwards — is the test immediately below. A one-sided fix
    // passes one and fails the other, so both are pinned here.
    //
    // This test began life as a CHARACTERIZATION of the KNOWN GAP left by
    // PR #192: the stand-down tested only for the EXISTENCE of a newer
    // full run, never for its outcome, so when that run rejected it
    // committed nothing and the superseded run had already thrown its own
    // scan away — neither result reached the store, and nothing rebuilt
    // it until the next save, folder change, or manual Refresh. Closing
    // #195 flipped it deliberately; it is now the regression test.
    patchConfig({});
    patchDiscoverApps(async () => []);
    const store = new EventIndexStore();
    try {
      const deferreds: Array<Deferred<EventIndex>> = [];
      let calls = 0;
      const indexFn = (): Promise<EventIndex> => {
        calls++;
        const d = deferred<EventIndex>();
        deferreds.push(d);
        return d.promise;
      };

      // Run A opts into recovery (as all three production callers do).
      const first = runIndexAndCommit(
        fakeContext(), store, indexFn, { reissueIfSuperseded: true }
      );
      // Run B is a newer full run — it bumps BOTH counters past A.
      const newer = runIndexAndCommit(fakeContext(), store, indexFn);
      await flush();
      assert.strictEqual(calls, 2, 'both runs started');

      // B fails. Nothing commits from it.
      deferreds[1].reject(new Error('synthetic buildIndex failure'));
      await assert.rejects(newer.done, /synthetic buildIndex failure/,
        'the rejection must still propagate to B\'s caller unchanged');

      // A now resolves and finds itself superseded by a run that has
      // ALREADY failed, with nothing newer behind it.
      deferreds[0].resolve(makeIndex('discarded-by-a-run-that-failed'));
      const firstResult = await first.done;
      await flush();

      assert.strictEqual(firstResult.committed, false,
        'the superseded run still does not commit its own stale scan');
      assert.strictEqual(firstResult.reissued, true,
        'nobody else is left to rebuild the discarded scan, so this run re-issues');
      assert.strictEqual(calls, 3,
        'exactly one replacement run is started — never more');

      // The replacement owns the newest generation, so it commits: the
      // discarded scan really is rebuilt rather than lost.
      const rebuilt = makeFullIndex();
      deferreds[2].resolve(rebuilt);
      await flush();

      assert.strictEqual(store.get(), rebuilt,
        'the re-issued run must commit the rebuilt full index');
      assert.strictEqual(store.isInitialized, true,
        'the store is no longer left empty by a superseder that failed');
      assert.strictEqual(calls, 3,
        'the replacement carries the flag OFF, so it arms nothing further');
    } finally {
      store.dispose();
    }
  });

  test('a run superseded by a newer full run that fails LATER re-issues exactly once (issue #195)', async () => {
    // ORDERING (ii) — the sequence in issue #195's body. The superseded
    // run F resolves and stands down FIRST, so it is already gone by the
    // time the superseding run R rejects and cannot observe the failure
    // itself. F therefore hands the rebuild off (re-issuing here instead
    // would race a run that may still be about to commit — the #113/#119
    // bug class) and R discharges that debt when it rejects.
    //
    // The replacement is started by R, so in production it re-runs R's
    // `indexFn`. That is identical work: all three callers pass
    // `runIndexWithProgress`, the same full workspace scan reading
    // `workspaceFolders` at call time. Both runs share one `indexFn` here
    // so the replacement is visible in the same call count either way.
    const store = new EventIndexStore();
    try {
      const deferreds: Array<Deferred<EventIndex>> = [];
      let calls = 0;
      const indexFn = (): Promise<EventIndex> => {
        calls++;
        const d = deferred<EventIndex>();
        deferreds.push(d);
        return d.promise;
      };

      const superseded = runIndexAndCommit(
        fakeContext(), store, indexFn, { reissueIfSuperseded: true }
      );
      const superseder = runIndexAndCommit(fakeContext(), store, indexFn);
      await flush();
      assert.strictEqual(calls, 2, 'both runs started');

      // F resolves first. A newer full run exists and is still in flight,
      // so F stands down and hands the rebuild off.
      deferreds[0].resolve(makeIndex('discarded-first'));
      const supersededResult = await superseded.done;
      await flush();
      assert.strictEqual(supersededResult.committed, false,
        'the superseded run does not commit');
      assert.strictEqual(supersededResult.reissued, false,
        'it hands the rebuild off rather than launching one itself');
      assert.strictEqual(calls, 2,
        'the hand-off starts nothing by itself');

      // R now rejects with nothing newer behind it, so the debt stops
      // here and R re-issues on the superseded run's behalf.
      deferreds[1].reject(new Error('synthetic buildIndex failure'));
      await assert.rejects(superseder.done, /synthetic buildIndex failure/,
        'the rejection must still propagate to its own caller unchanged');
      await flush();
      assert.strictEqual(calls, 3,
        'the failing superseder must re-issue exactly one replacement scan');

      const rebuilt = makeFullIndex();
      deferreds[2].resolve(rebuilt);
      await flush();

      assert.strictEqual(store.get(), rebuilt,
        'the replacement commits the rebuilt full index');
      assert.strictEqual(store.isInitialized, true,
        'the store is no longer left empty in this ordering either');
      assert.strictEqual(calls, 3,
        'the replacement carries the flag OFF, so it arms nothing further');
    } finally {
      store.dispose();
    }
  });

  test('a replacement started by a failing superseder that itself fails does not start a third run', async () => {
    // AC 4 — the rebuild-loop bound on the hand-off path. The debt is
    // cleared BEFORE the replacement starts, and the replacement carries
    // the flag off (so it can neither take a re-issue branch nor record a
    // debt of its own): its rejection finds nothing owed and stops.
    const store = new EventIndexStore();
    try {
      const deferreds: Array<Deferred<EventIndex>> = [];
      let calls = 0;
      const indexFn = (): Promise<EventIndex> => {
        calls++;
        const d = deferred<EventIndex>();
        deferreds.push(d);
        return d.promise;
      };

      const superseded = runIndexAndCommit(
        fakeContext(), store, indexFn, { reissueIfSuperseded: true }
      );
      const superseder = runIndexAndCommit(fakeContext(), store, indexFn);
      await flush();

      // Hand off, then discharge the debt by rejecting the superseder.
      deferreds[0].resolve(makeIndex('discarded-first'));
      await superseded.done;
      await flush();
      deferreds[1].reject(new Error('superseder failed'));
      await assert.rejects(superseder.done, /superseder failed/);
      await flush();
      assert.strictEqual(calls, 3, 'the debt produced exactly one replacement');

      // The replacement fails too. Its rejection is detached (nothing
      // awaits it but `startReissue`'s own catch), and it must not start
      // yet another run.
      deferreds[2].reject(new Error('replacement also failed'));
      await flush();
      await flush();

      assert.strictEqual(calls, 3,
        'each debt discharges exactly once — a failing replacement must NOT start a third run');
      assert.strictEqual(store.isInitialized, false,
        'nothing committed, but nothing looped either');
    } finally {
      store.dispose();
    }
  });

  test('a superseded run whose superseder COMMITTED leaves no debt behind', async () => {
    // AC 2, and the whole reason `latestCommittedRunSeq` exists. When the
    // newer full run has already committed, its scan supersedes the
    // discarded one and nothing is owed. Recording a debt here anyway
    // would make it permanently sticky, so the next unrelated failure —
    // arbitrarily far in the future — would fire a spurious full rebuild.
    // The existing AC 2 tests cannot catch that: they assert the absence
    // of an *immediate* re-issue, which a sticky debt does not cause.
    const store = new EventIndexStore();
    try {
      const deferreds: Array<Deferred<EventIndex>> = [];
      let calls = 0;
      const indexFn = (): Promise<EventIndex> => {
        calls++;
        const d = deferred<EventIndex>();
        deferreds.push(d);
        return d.promise;
      };

      const superseded = runIndexAndCommit(
        fakeContext(), store, indexFn, { reissueIfSuperseded: true }
      );
      const superseder = runIndexAndCommit(fakeContext(), store, indexFn);
      await flush();
      assert.strictEqual(calls, 2, 'both runs started');

      // The newer full run commits.
      const committedIndex = makeIndex('superseder');
      deferreds[1].resolve(committedIndex);
      const supersederResult = await superseder.done;
      assert.strictEqual(supersederResult.committed, true,
        'the newer full run owns the latest generation, so it commits');

      // The superseded run stands down with nothing owed.
      deferreds[0].resolve(makeIndex('discarded'));
      const supersededResult = await superseded.done;
      await flush();
      assert.strictEqual(supersededResult.reissued, false,
        'a run whose superseder already committed must not re-issue');
      assert.strictEqual(calls, 2, 'no replacement is started');

      // An unrelated later run fails. With no debt outstanding, its
      // rejection must start nothing at all.
      const later = runIndexAndCommit(fakeContext(), store, indexFn);
      await flush();
      assert.strictEqual(calls, 3, 'the unrelated run is the third indexFn call');

      deferreds[2].reject(new Error('unrelated failure'));
      await assert.rejects(later.done, /unrelated failure/);
      await flush();

      assert.strictEqual(calls, 3,
        'a failure with no outstanding debt must not start a rebuild');
      assert.strictEqual(store.get(), committedIndex,
        'the store still holds the scan the superseder committed');
    } finally {
      store.dispose();
    }
  });

  test('a run that entered before resetExtensionStateForReload does not re-issue after it', async () => {
    // The post-reset trap. `resetExtensionStateForReload` zeroes every
    // counter, which makes `latestFailedRunSeq === latestRunSeq`
    // vacuously true (0 === 0) — so without the `runSeq > latestRunSeq`
    // early return, a run that entered BEFORE the reset would fire a
    // rebuild against a store `deactivate()` has already disposed.
    // Because the counter is monotonic otherwise, `runSeq > latestRunSeq`
    // is an exact test for "a reset happened under me".
    //
    // Placed LAST in this suite deliberately: it zeroes module state that
    // every other test in the process shares, so it must leave nothing in
    // flight behind it.
    const store = new EventIndexStore();
    try {
      let calls = 0;
      const d = deferred<EventIndex>();
      const run = runIndexAndCommit(
        fakeContext(), store,
        () => { calls++; return d.promise; },
        { reissueIfSuperseded: true }
      );
      await flush();
      assert.strictEqual(calls, 1, 'one run in flight across the reset');

      // `deactivate()` — the module's counters go back to zero.
      resetExtensionStateForReload();

      d.resolve(makeIndex('pre-reset'));
      const result = await run.done;
      await flush();

      assert.strictEqual(result.committed, false,
        'a pre-reset run must not commit into the next activation');
      assert.strictEqual(result.reissued, false,
        'and must not fire a rebuild against a disposed store');
      assert.strictEqual(calls, 1, 'no replacement run is started');
      assert.strictEqual(store.isInitialized, false,
        'nothing reached the store');
    } finally {
      store.dispose();
    }
  });
});

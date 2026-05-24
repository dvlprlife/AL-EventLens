import * as assert from 'assert';
import * as vscode from 'vscode';
import type { Publisher, Subscriber } from '../../al/types';
import type { EventIndex } from '../../index/indexer';
import {
  hasAnyGenerationCommitted,
  resetAnyGenerationCommittedForTesting,
  runIndexAndCommit
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
  // The module-scoped `anyGenerationCommitted` flag is sticky across the
  // whole test process, so each test resets it (and the wrapping
  // afterwards is belt-and-suspenders).
  setup(() => { resetAnyGenerationCommittedForTesting(); });
  teardown(() => {
    resetAnyGenerationCommittedForTesting();
    restoreConfig();
    restoreDiscoverApps();
  });

  test('initial fails with no overlapping refresh: store still initialized via empty fallback', async () => {
    // This is the baseline guard for the activation path's failure
    // handler — the behavior PR #104 was meant to preserve.
    const store = new EventIndexStore();
    try {
      assert.strictEqual(hasAnyGenerationCommitted(), false,
        'precondition: no run has committed yet');

      // Simulate the activation path: kick off a failing run.
      const initial = runIndexAndCommit(
        fakeContext(),
        store,
        async () => { throw new Error('initial boom'); }
      );

      // Mirror extension.ts's failure handler: empty-index fallback
      // gated on `hasAnyGenerationCommitted()`.
      await initial.done.catch(() => {
        if (!hasAnyGenerationCommitted()) {
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
    // Defect 1: post-#104, the activation gate used `isLatestGeneration`,
    // so a refresh that overlapped the initial pass took ownership of
    // the latest generation — and when the refresh later FAILED (only
    // logged, no fallback), the initial's failure handler ALSO refused
    // to install the empty fallback because its generation was no
    // longer "latest". Result: store never initialized, spinner forever.
    // The fix gates on `hasAnyGenerationCommitted()` instead, which is
    // still `false` when both fail.
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
        if (!hasAnyGenerationCommitted()) {
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

import * as assert from 'assert';
import * as vscode from 'vscode';
import type { EventIndex } from '../../index/indexer';
import { registerWorkspaceFolderReindex } from '../../index/folderWatcher';
import { bumpStartedGeneration } from '../../index/reindex';
import { EventIndexStore } from '../../index/store';

// ─── Deferred promise helper ───────────────────────────────────────────
//
// Mirrors the helper in concurrencyRace.test.ts. Lets the save-during-
// folder-rebuild tests orchestrate resolution order explicitly so a slow
// rebuild and a save (or a second folder change) interleave deterministically.

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

/** Flush the microtask + setImmediate queue so the watcher's promise chain runs. */
function flush(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

// ─── Test harness: capture the listener registered against
// vscode.workspace.onDidChangeWorkspaceFolders so we can fire it on demand
// without orchestrating real workspace folder mutations. ───────────────────

const realOnDidChange = vscode.workspace.onDidChangeWorkspaceFolders;
let captured: ((e: vscode.WorkspaceFoldersChangeEvent) => void) | undefined;
let captureDisposed: boolean;

function patchOnDidChange(): void {
  captured = undefined;
  captureDisposed = false;
  Object.defineProperty(vscode.workspace, 'onDidChangeWorkspaceFolders', {
    configurable: true,
    value: (cb: (e: vscode.WorkspaceFoldersChangeEvent) => void): vscode.Disposable => {
      captured = cb;
      return {
        dispose: (): void => {
          captureDisposed = true;
        }
      };
    }
  });
}

function restoreOnDidChange(): void {
  Object.defineProperty(vscode.workspace, 'onDidChangeWorkspaceFolders', {
    configurable: true,
    value: realOnDidChange
  });
  captured = undefined;
}

function fakeContext(): vscode.ExtensionContext {
  return { subscriptions: [] } as unknown as vscode.ExtensionContext;
}

function fakeEvent(): vscode.WorkspaceFoldersChangeEvent {
  return { added: [], removed: [] };
}

const emptyIndex: EventIndex = {
  publishers: [],
  subscribers: [],
  appMeta: new Map()
};

// ─── Tests ──────────────────────────────────────────────────────────────

suite('index/folderWatcher: registerWorkspaceFolderReindex', () => {
  teardown(restoreOnDidChange);

  test('subscribes to vscode.workspace.onDidChangeWorkspaceFolders on construction', () => {
    patchOnDidChange();
    const store = new EventIndexStore();
    try {
      registerWorkspaceFolderReindex(fakeContext(), store, async () => emptyIndex);
      assert.ok(captured, 'expected the watcher to have registered a callback against onDidChangeWorkspaceFolders');
    } finally {
      store.dispose();
    }
  });

  test('returns a Disposable that unsubscribes the underlying listener', () => {
    patchOnDidChange();
    const store = new EventIndexStore();
    try {
      const sub = registerWorkspaceFolderReindex(fakeContext(), store, async () => emptyIndex);
      assert.strictEqual(captureDisposed, false);
      sub.dispose();
      assert.strictEqual(captureDisposed, true,
        'disposing the returned subscription must dispose the underlying event listener');
    } finally {
      store.dispose();
    }
  });

  test('firing the workspace-folder-change event re-runs indexFn and pipes the result into the store', async () => {
    patchOnDidChange();
    const store = new EventIndexStore();
    try {
      const updates: EventIndex[] = [];
      store.onDidChange((idx) => updates.push(idx));

      let calls = 0;
      const fakeIndex: EventIndex = {
        publishers: [{ owner: { kind: 'codeunit', name: 'NewCu' }, eventName: 'OnSomething', kind: 'integration' }],
        subscribers: [],
        appMeta: new Map()
      };
      const indexFn = async (): Promise<EventIndex> => {
        calls++;
        return fakeIndex;
      };

      registerWorkspaceFolderReindex(fakeContext(), store, indexFn);
      assert.strictEqual(calls, 0, 'indexFn should NOT run on register — only on actual folder changes');

      // Fire the event and await the async chain.
      captured!(fakeEvent());
      // Allow the promise chain inside the listener to resolve.
      await new Promise<void>((resolve) => setImmediate(resolve));

      assert.strictEqual(calls, 1, 'folder change must trigger exactly one indexFn invocation');
      assert.strictEqual(updates.length, 1, 'store.set must fire exactly once');
      assert.deepStrictEqual(updates[0].publishers, fakeIndex.publishers);
      assert.strictEqual(store.get(), fakeIndex,
        'store must hold the new index after the folder-change cycle');
      assert.strictEqual(store.isInitialized, true,
        'first set should also flip isInitialized — same as the activation path');
    } finally {
      store.dispose();
    }
  });

  test('indexFn rejection is logged but does not propagate or corrupt the store', async () => {
    patchOnDidChange();
    const store = new EventIndexStore();
    const originalConsoleError = console.error;
    const errorCalls: unknown[][] = [];
    Object.defineProperty(console, 'error', {
      configurable: true,
      writable: true,
      value: (...args: unknown[]): void => { errorCalls.push(args); }
    });
    try {
      const failingIndexFn = async (): Promise<EventIndex> => {
        throw new Error('indexer exploded');
      };
      registerWorkspaceFolderReindex(fakeContext(), store, failingIndexFn);

      captured!(fakeEvent());
      await new Promise<void>((resolve) => setImmediate(resolve));

      // The store stays at its initial empty state — no set fired.
      assert.strictEqual(store.isInitialized, false,
        'a failed reindex must NOT flip isInitialized (no set was called)');
      assert.ok(errorCalls.length >= 1, 'rejection must be logged via console.error');
      assert.ok(
        errorCalls.some((args) => args.some((a) =>
          typeof a === 'string' && a.includes('re-index after workspace folder change failed')
        )),
        `expected error log to mention the failure mode; got: ${JSON.stringify(errorCalls)}`
      );
    } finally {
      Object.defineProperty(console, 'error', {
        configurable: true,
        writable: true,
        value: originalConsoleError
      });
      store.dispose();
    }
  });

  // ─── Save-during-folder-rebuild re-issue (issue #128) ──────────────────

  test('a save during an in-flight folder rebuild re-issues a fresh rebuild that lands the new folder', async () => {
    // Issue #128: adding a workspace folder kicks off a full re-scan. If
    // the user saved a `.al` file before that scan finished, the save's
    // generation bump suppressed the rebuild's commit (last-started-wins),
    // so the newly-added folder's publishers never appeared until a manual
    // Refresh. The folder watcher now inspects the `committed` flag and,
    // when superseded, re-issues exactly one fresh full rebuild.
    patchOnDidChange();
    const store = new EventIndexStore();
    try {
      // The "new folder included" snapshot the *re-issued* rebuild returns.
      const newFolderIndex: EventIndex = {
        publishers: [{ owner: { kind: 'codeunit', name: 'AddedFolderCu' }, eventName: 'OnFolderAdded', kind: 'integration' }],
        subscribers: [],
        appMeta: new Map()
      };

      const deferreds: Array<Deferred<EventIndex>> = [];
      let calls = 0;
      const indexFn = (): Promise<EventIndex> => {
        calls++;
        const d = deferred<EventIndex>();
        deferreds.push(d);
        return d.promise;
      };

      registerWorkspaceFolderReindex(fakeContext(), store, indexFn);

      // Fire the folder-change event → rebuild (gen N) starts, suspended.
      captured!(fakeEvent());
      await flush();
      assert.strictEqual(calls, 1, 'folder change must start exactly one rebuild');

      // A save lands during the rebuild and bumps the started-generation
      // counter — this is the only side effect that supersedes the rebuild.
      bumpStartedGeneration();

      // Resolve the first rebuild. Its commit is suppressed (committed:
      // false), so the watcher must re-issue a fresh rebuild.
      deferreds[0].resolve(emptyIndex);
      await flush();
      assert.strictEqual(calls, 2,
        'a superseded folder rebuild must re-issue exactly one fresh rebuild');

      // Resolve the re-issued rebuild with the "new folder included" snapshot.
      // Being the newest run, it commits.
      deferreds[1].resolve(newFolderIndex);
      await flush();

      assert.strictEqual(store.get(), newFolderIndex,
        'the re-issued rebuild must commit the full workspace including the new folder');
      assert.strictEqual(store.isInitialized, true,
        'the committed re-issue flips isInitialized');
      const names = store.get().publishers.map((p) => p.eventName);
      assert.ok(names.includes('OnFolderAdded'),
        `the new folder's publisher must be present; got [${names.join(', ')}]`);
    } finally {
      store.dispose();
    }
  });

  test('a folder rebuild that commits normally does NOT re-issue (no supersession, no extra build)', async () => {
    // Guard: the re-issue must fire ONLY when superseded. A folder rebuild
    // that commits (committed: true) must not trigger a second indexFn.
    patchOnDidChange();
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

      registerWorkspaceFolderReindex(fakeContext(), store, indexFn);

      captured!(fakeEvent());
      await flush();
      assert.strictEqual(calls, 1);

      // Resolve with no intervening bump → this run is newest → it commits.
      const committed: EventIndex = {
        publishers: [{ owner: { kind: 'codeunit', name: 'HappyCu' }, eventName: 'OnHappy', kind: 'integration' }],
        subscribers: [],
        appMeta: new Map()
      };
      deferreds[0].resolve(committed);
      await flush();

      assert.strictEqual(calls, 1,
        'a rebuild that commits normally must NOT re-issue a second indexFn');
      assert.strictEqual(store.get(), committed,
        'the committed rebuild is the final store state');
    } finally {
      store.dispose();
    }
  });

  test('a newer folder change cancels the stale re-issue — no ping-pong', async () => {
    // Guard: fire the folder callback twice (two rebuilds in flight). Let
    // the SECOND commit, then resolve the first as committed: false. The
    // first must NOT re-issue, because the second event advanced
    // folderChangeSeq (mySeq !== folderChangeSeq). Total indexFn
    // invocations stay bounded at 2, not 3+.
    patchOnDidChange();
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

      registerWorkspaceFolderReindex(fakeContext(), store, indexFn);

      // First folder change → rebuild #1 (gen N, seq 1).
      captured!(fakeEvent());
      await flush();
      // Second folder change → rebuild #2 (gen N+1, seq 2) — advances the
      // started generation AND folderChangeSeq.
      captured!(fakeEvent());
      await flush();
      assert.strictEqual(calls, 2, 'two folder changes start two rebuilds');

      // The second rebuild commits first (it owns the latest generation).
      const secondIndex: EventIndex = {
        publishers: [{ owner: { kind: 'codeunit', name: 'SecondCu' }, eventName: 'OnSecond', kind: 'integration' }],
        subscribers: [],
        appMeta: new Map()
      };
      deferreds[1].resolve(secondIndex);
      await flush();
      assert.strictEqual(store.get(), secondIndex,
        'the second (latest) rebuild commits');

      // Now the first rebuild resolves — superseded by the second, so
      // committed: false. But mySeq (1) !== folderChangeSeq (2), so it must
      // NOT re-issue.
      deferreds[0].resolve(emptyIndex);
      await flush();

      assert.strictEqual(calls, 2,
        'a stale rebuild superseded by a NEWER folder change must NOT re-issue (no ping-pong)');
      assert.strictEqual(store.get(), secondIndex,
        'the store still reflects the committed second rebuild');
    } finally {
      store.dispose();
    }
  });
});

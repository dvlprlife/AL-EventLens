import * as assert from 'assert';
import * as vscode from 'vscode';
import type { EventIndex } from '../../index/indexer';
import { registerWorkspaceFolderReindex } from '../../index/folderWatcher';
import { EventIndexStore } from '../../index/store';

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
});

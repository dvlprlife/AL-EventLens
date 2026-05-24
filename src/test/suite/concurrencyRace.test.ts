import * as assert from 'assert';
import * as vscode from 'vscode';
import type { Publisher, Subscriber } from '../../al/types';
import type { EventIndex } from '../../index/indexer';
import { runIndexAndCommit } from '../../index/reindex';
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

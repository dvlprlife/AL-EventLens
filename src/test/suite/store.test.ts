import * as assert from 'assert';
import * as vscode from 'vscode';
import type { EventKind, ObjectKind, Publisher, Subscriber } from '../../al/types';
import type { EventIndex } from '../../index/indexer';
import { EventIndexStore, type FileUpdate } from '../../index/store';

// ─── Fixtures ────────────────────────────────────────────────────────────

function makePublisher(
  kind: ObjectKind,
  name: string,
  eventName: string,
  opts?: { kind?: EventKind; uri?: vscode.Uri; sourceUri?: vscode.Uri; appId?: string }
): Publisher {
  return {
    owner: { kind, name, appId: opts?.appId },
    eventName,
    kind: opts?.kind ?? 'integration',
    location: opts?.uri
      ? new vscode.Location(opts.uri, new vscode.Position(0, 0))
      : undefined,
    sourceUri: opts?.sourceUri
  };
}

function makeSubscriber(
  targetKind: ObjectKind,
  targetName: string,
  targetEvent: string,
  opts?: { uri?: vscode.Uri; resolved?: boolean }
): Subscriber {
  const uri = opts?.uri ?? vscode.Uri.parse('file:///x.al');
  return {
    owner: { kind: 'codeunit', name: 'Some Subscriber' },
    target: { kind: targetKind, name: targetName },
    targetEvent,
    location: new vscode.Location(uri, new vscode.Position(0, 0)),
    resolved: opts?.resolved ?? false
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────

suite('index/store: EventIndexStore', () => {
  test('initial state is empty', () => {
    const store = new EventIndexStore();
    try {
      const idx = store.get();
      assert.strictEqual(idx.publishers.length, 0);
      assert.strictEqual(idx.subscribers.length, 0);
    } finally {
      store.dispose();
    }
  });

  test('set fires onDidChange with the new index (payload identity preserved)', () => {
    const store = new EventIndexStore();
    try {
      const fired: EventIndex[] = [];
      store.onDidChange((idx) => fired.push(idx));

      const next: EventIndex = {
        publishers: [makePublisher('codeunit', 'C', 'OnX')],
        subscribers: [],
        appMeta: new Map()
      };
      store.set(next);

      assert.strictEqual(fired.length, 1);
      assert.strictEqual(fired[0], next, 'event payload must be the exact index instance set');
      assert.strictEqual(store.get(), next);
    } finally {
      store.dispose();
    }
  });

  test('updateFile fires onDidUpdateFile (not onDidChange), with the file delta', () => {
    const store = new EventIndexStore();
    try {
      const fileUri = vscode.Uri.parse('file:///workspace/A.al');
      let changeCount = 0;
      const updates: FileUpdate[] = [];
      store.onDidChange(() => changeCount++);
      store.onDidUpdateFile((u) => updates.push(u));

      store.updateFile(fileUri, [makePublisher('codeunit', 'A', 'OnA', { uri: fileUri })], []);

      assert.strictEqual(changeCount, 0, 'updateFile must not fire the full-replace onDidChange');
      assert.strictEqual(updates.length, 1, 'updateFile must fire onDidUpdateFile exactly once');
      assert.strictEqual(updates[0].uri, fileUri);
      assert.deepStrictEqual(updates[0].publishers.map((p) => p.eventName), ['OnA'],
        'payload publishers must be the saved file\'s own publishers');
      assert.strictEqual(store.get().publishers.length, 1);
    } finally {
      store.dispose();
    }
  });

  test('onDidUpdateFile payload carries the full, freshly re-resolved subscriber list', () => {
    const store = new EventIndexStore();
    try {
      const subUri = vscode.Uri.parse('file:///workspace/Sub.al');
      const pubUri = vscode.Uri.parse('file:///workspace/Pub.al');
      store.set({
        publishers: [],
        subscribers: [makeSubscriber('codeunit', 'Sales-Post', 'OnAfterPostSalesDoc', { uri: subUri })],
        appMeta: new Map()
      });
      const updates: FileUpdate[] = [];
      store.onDidUpdateFile((u) => updates.push(u));

      // Saving Pub.al adds the matching publisher — the Sub.al subscriber (a
      // different file) must flip to resolved, and the delta payload must
      // carry the whole re-resolved list so the panel stays correct.
      store.updateFile(pubUri, [
        makePublisher('codeunit', 'Sales-Post', 'OnAfterPostSalesDoc', { uri: pubUri })
      ], []);

      assert.strictEqual(updates.length, 1);
      assert.strictEqual(updates[0].subscribers.length, 1,
        'payload carries the full subscriber list, not just the saved file\'s');
      assert.strictEqual(updates[0].subscribers[0].resolved, true,
        'a subscriber in another file re-resolves and the payload reflects it');
    } finally {
      store.dispose();
    }
  });

  test('updateFile drops existing publishers and subscribers attributed to the URI before adding new ones', () => {
    const store = new EventIndexStore();
    try {
      const fileA = vscode.Uri.parse('file:///workspace/A.al');
      const fileB = vscode.Uri.parse('file:///workspace/B.al');

      // Seed: two publishers and two subscribers, one of each in fileA, the other in fileB.
      store.set({
        publishers: [
          makePublisher('codeunit', 'A', 'OnAOld', { uri: fileA }),
          makePublisher('codeunit', 'B', 'OnB', { uri: fileB })
        ],
        subscribers: [
          makeSubscriber('codeunit', 'X', 'OnX', { uri: fileA }),
          makeSubscriber('codeunit', 'Y', 'OnY', { uri: fileB })
        ],
        appMeta: new Map()
      });

      // Re-save fileA with one new publisher and no subscribers.
      store.updateFile(fileA, [makePublisher('codeunit', 'A', 'OnANew', { uri: fileA })], []);

      const idx = store.get();
      const eventNames = idx.publishers.map((p) => p.eventName).sort();
      assert.deepStrictEqual(eventNames, ['OnANew', 'OnB'],
        'old fileA publisher dropped, fileB publisher untouched, new fileA publisher added');

      const subTargets = idx.subscribers.map((s) => s.target.name).sort();
      assert.deepStrictEqual(subTargets, ['Y'],
        'fileA subscriber dropped, fileB subscriber preserved');
    } finally {
      store.dispose();
    }
  });

  test('updateFile drops existing trigger publishers attributed by sourceUri to the saved file', () => {
    const store = new EventIndexStore();
    try {
      const fileA = vscode.Uri.parse('file:///workspace/MyTable.al');
      const fileB = vscode.Uri.parse('file:///workspace/Other.al');

      // Seed with trigger publishers from both files (location undefined,
      // sourceUri set — this is the watcher's contribution shape).
      store.set({
        publishers: [
          makePublisher('table', 'MyTable', 'OnAfterInsertEvent', {
            kind: 'trigger',
            sourceUri: fileA
          }),
          makePublisher('table', 'MyTable', 'OnAfterDeleteEvent', {
            kind: 'trigger',
            sourceUri: fileA
          }),
          makePublisher('table', 'OtherTable', 'OnAfterInsertEvent', {
            kind: 'trigger',
            sourceUri: fileB
          })
        ],
        subscribers: [],
        appMeta: new Map()
      });

      // Re-save fileA with a single new trigger publisher.
      store.updateFile(fileA, [
        makePublisher('table', 'MyTable', 'OnAfterModifyEvent', {
          kind: 'trigger',
          sourceUri: fileA
        })
      ], []);

      const idx = store.get();
      const triggerEvents = idx.publishers
        .filter((p) => p.kind === 'trigger')
        .map((p) => `${p.owner.name}.${p.eventName}`)
        .sort();
      assert.deepStrictEqual(triggerEvents,
        ['MyTable.OnAfterModifyEvent', 'OtherTable.OnAfterInsertEvent'],
        'old fileA triggers dropped (matched on sourceUri), fileB trigger preserved, new fileA trigger added');
    } finally {
      store.dispose();
    }
  });

  test('updateFile: a workspace Table save supersedes the bundled .app twin trigger set (#130)', () => {
    const store = new EventIndexStore();
    try {
      const fileA = vscode.Uri.parse('file:///workspace/MyTable.al');
      const APP = '11111111-1111-1111-1111-111111111111';

      // Seed with the .app-bundled trigger set for MyTable (both location and
      // sourceUri undefined — the bundled shape), plus an unrelated bundled
      // table's trigger that must survive the save.
      store.set({
        publishers: [
          makePublisher('table', 'MyTable', 'OnAfterInsertEvent', { kind: 'trigger', appId: APP }),
          makePublisher('table', 'MyTable', 'OnAfterDeleteEvent', { kind: 'trigger', appId: APP }),
          makePublisher('table', 'OtherTable', 'OnAfterInsertEvent', { kind: 'trigger', appId: APP })
        ],
        subscribers: [],
        appMeta: new Map()
      });

      // Save the workspace copy of MyTable: re-synthesized triggers carry
      // sourceUri = fileA and the same appId.
      store.updateFile(fileA, [
        makePublisher('table', 'MyTable', 'OnAfterInsertEvent', { kind: 'trigger', sourceUri: fileA, appId: APP }),
        makePublisher('table', 'MyTable', 'OnAfterModifyEvent', { kind: 'trigger', sourceUri: fileA, appId: APP })
      ], []);

      const idx = store.get();
      const triggerEvents = idx.publishers
        .filter((p) => p.kind === 'trigger')
        .map((p) => `${p.owner.name}.${p.eventName}`)
        .sort();
      // The bundled MyTable set (Insert/Delete) is superseded by the workspace
      // set (Insert/Modify); OtherTable's bundled trigger is untouched.
      assert.deepStrictEqual(triggerEvents,
        ['MyTable.OnAfterInsertEvent', 'MyTable.OnAfterModifyEvent', 'OtherTable.OnAfterInsertEvent'],
        'bundled MyTable triggers superseded by the workspace save; unrelated bundled table preserved');
      // No leftover bundled (location + sourceUri both undefined) MyTable trigger.
      const leftoverBundled = idx.publishers.filter(
        (p) => p.kind === 'trigger' && p.owner.name === 'MyTable'
          && p.location === undefined && p.sourceUri === undefined
      );
      assert.strictEqual(leftoverBundled.length, 0,
        'no bundled MyTable trigger may survive the supersede');
    } finally {
      store.dispose();
    }
  });

  test('updateFile: supersede holds when bundled vs workspace appId differ only in GUID case (#130)', () => {
    const store = new EventIndexStore();
    try {
      const fileA = vscode.Uri.parse('file:///workspace/MyTable.al');
      const APP_UPPER = 'AAAAAAAA-1111-2222-3333-444444444444';
      const APP_LOWER = 'aaaaaaaa-1111-2222-3333-444444444444';

      // Bundled twin tagged with the UPPER-cased GUID (NavxManifest.xml `Id`).
      store.set({
        publishers: [
          makePublisher('table', 'MyTable', 'OnAfterInsertEvent', { kind: 'trigger', appId: APP_UPPER }),
          makePublisher('table', 'MyTable', 'OnAfterDeleteEvent', { kind: 'trigger', appId: APP_UPPER })
        ],
        subscribers: [],
        appMeta: new Map()
      });

      // Workspace save tagged with the lower-cased GUID (app.json `id`).
      store.updateFile(fileA, [
        makePublisher('table', 'MyTable', 'OnAfterInsertEvent', { kind: 'trigger', sourceUri: fileA, appId: APP_LOWER })
      ], []);

      const idx = store.get();
      const myTableTriggers = idx.publishers.filter(
        (p) => p.kind === 'trigger' && p.owner.name === 'MyTable'
      );
      // The case-only appId difference must still supersede (ownerKey
      // lower-cases appId), leaving exactly the one workspace trigger.
      assert.strictEqual(myTableTriggers.length, 1,
        `case-only appId difference must still supersede; got ${myTableTriggers.length}`);
      assert.strictEqual(myTableTriggers[0].sourceUri?.toString(), fileA.toString(),
        'the surviving trigger must be the workspace one (sourceUri = saved file)');
    } finally {
      store.dispose();
    }
  });

  test('updateFile re-runs resolveSubscribers: a subscriber resolves when its publisher is added', () => {
    const store = new EventIndexStore();
    try {
      const subUri = vscode.Uri.parse('file:///workspace/Sub.al');
      const pubUri = vscode.Uri.parse('file:///workspace/Pub.al');

      // Seed with an unresolved subscriber and no publishers.
      store.set({
        publishers: [],
        subscribers: [makeSubscriber('codeunit', 'Sales-Post', 'OnAfterPostSalesDoc', { uri: subUri })],
        appMeta: new Map()
      });
      assert.strictEqual(store.get().subscribers[0].resolved, false);

      // Add the matching publisher via updateFile on a different URI.
      store.updateFile(pubUri, [
        makePublisher('codeunit', 'Sales-Post', 'OnAfterPostSalesDoc', { uri: pubUri })
      ], []);

      assert.strictEqual(store.get().subscribers[0].resolved, true,
        'subscriber must now resolve against the freshly-added publisher');
    } finally {
      store.dispose();
    }
  });

  test('updateFile re-runs resolveSubscribers: a subscriber unresolves when its publisher is removed', () => {
    const store = new EventIndexStore();
    try {
      const subUri = vscode.Uri.parse('file:///workspace/Sub.al');
      const pubUri = vscode.Uri.parse('file:///workspace/Pub.al');

      // Seed with resolved: true since `set` does not run resolveSubscribers
      // (it stores the index as-is — this matches the buildIndex contract).
      store.set({
        publishers: [
          makePublisher('codeunit', 'Sales-Post', 'OnAfterPostSalesDoc', { uri: pubUri })
        ],
        subscribers: [
          makeSubscriber('codeunit', 'Sales-Post', 'OnAfterPostSalesDoc', { uri: subUri, resolved: true })
        ],
        appMeta: new Map()
      });
      assert.strictEqual(store.get().subscribers[0].resolved, true);

      // Re-save Pub.al with the publisher removed (empty publisher list).
      store.updateFile(pubUri, [], []);

      assert.strictEqual(store.get().subscribers[0].resolved, false,
        'subscriber must un-resolve once the publisher disappears');
    } finally {
      store.dispose();
    }
  });

  test('dispose releases the EventEmitter so subsequent set fires no listeners', () => {
    const store = new EventIndexStore();
    let fired = 0;
    store.onDidChange(() => fired++);
    store.dispose();

    // After dispose, the underlying emitter is disposed; firing it via
    // `set` must not invoke the previously-registered listener.
    store.set({ publishers: [], subscribers: [], appMeta: new Map() });
    assert.strictEqual(fired, 0, 'listener should not fire after dispose');
  });

  test('isInitialized: false until the first set, then true (and stays true through subsequent sets)', () => {
    const store = new EventIndexStore();
    try {
      assert.strictEqual(store.isInitialized, false,
        'a fresh store must report uninitialized so the tree shows the indexing placeholder');
      store.set({ publishers: [], subscribers: [], appMeta: new Map() });
      assert.strictEqual(store.isInitialized, true,
        'set must flip isInitialized — even when the index it received is empty');
      store.set({ publishers: [], subscribers: [], appMeta: new Map() });
      assert.strictEqual(store.isInitialized, true,
        'isInitialized never flips back');
    } finally {
      store.dispose();
    }
  });

  test('isInitialized: also flips on updateFile (in case incremental save fires before any full pass)', () => {
    const store = new EventIndexStore();
    try {
      assert.strictEqual(store.isInitialized, false);
      store.updateFile(vscode.Uri.parse('file:///x.al'), [], []);
      assert.strictEqual(store.isInitialized, true);
    } finally {
      store.dispose();
    }
  });
});

import * as assert from 'assert';
import * as vscode from 'vscode';
import type { EventKind, ObjectKind, Publisher, Subscriber } from '../../al/types';
import type { EventIndex } from '../../index/indexer';
import { EventIndexStore } from '../../index/store';

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

  test('updateFile fires onDidChange', () => {
    const store = new EventIndexStore();
    try {
      const fileUri = vscode.Uri.parse('file:///workspace/A.al');
      let fireCount = 0;
      store.onDidChange(() => fireCount++);

      store.updateFile(fileUri, [makePublisher('codeunit', 'A', 'OnA', { uri: fileUri })], []);

      assert.strictEqual(fireCount, 1);
      assert.strictEqual(store.get().publishers.length, 1);
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
});

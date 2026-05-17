import * as assert from 'assert';
import * as vscode from 'vscode';
import type { AppMeta, EventKind, ObjectKind, Publisher, Subscriber } from '../../al/types';
import { EventIndexStore } from '../../index/store';
import { EventTreeDataProvider, type TreeNode } from '../../ui/treeView';

// ─── Fixtures (mirrors store.test.ts shape) ─────────────────────────────

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

suite('ui/treeView: EventTreeDataProvider', () => {
  test('groups publishers by appId, with `(workspace)` bucket first then alphabetical', () => {
    const store = new EventIndexStore();
    try {
      store.set({
        publishers: [
          makePublisher('codeunit', 'Sales-Post', 'OnAfterPostSalesDoc', { appId: 'Microsoft.SalesMgmt' }),
          makePublisher('codeunit', 'Purch.-Post', 'OnAfterPostPurchase', { appId: 'Microsoft.SalesMgmt' }),
          makePublisher('codeunit', 'My Workspace Codeunit', 'OnSomething')
        ],
        subscribers: [],
        appMeta: new Map()
      });

      const provider = new EventTreeDataProvider(store);
      const roots = provider.getChildren() as TreeNode[];

      assert.strictEqual(roots.length, 2, 'two app buckets expected');
      assert.strictEqual(roots[0].kind, 'app');
      assert.strictEqual(roots[1].kind, 'app');
      const appRoots = roots as Array<Extract<TreeNode, { kind: 'app' }>>;
      assert.strictEqual(appRoots[0].label, '(workspace)', '(workspace) must come first');
      assert.strictEqual(appRoots[1].label, 'Microsoft.SalesMgmt',
        'no appMeta entry → label falls back to the raw appId');
    } finally {
      store.dispose();
    }
  });

  test('event leaf label is `<EventName> · (N)` with the live subscriber count — both 0 and >0', () => {
    const store = new EventIndexStore();
    try {
      const pubA = makePublisher('codeunit', 'Sales-Post', 'OnAfterPostSalesDoc');
      const pubB = makePublisher('codeunit', 'NoListenersHere', 'OnIdle');
      store.set({
        publishers: [pubA, pubB],
        subscribers: [
          // case-insensitive name match should still count
          makeSubscriber('codeunit', 'sales-post', 'onafterpostsalesdoc'),
          makeSubscriber('codeunit', 'Sales-Post', 'OnAfterPostSalesDoc')
        ],
        appMeta: new Map()
      });

      const provider = new EventTreeDataProvider(store);
      const [appNode] = provider.getChildren() as TreeNode[];
      const [kindNode] = provider.getChildren(appNode) as TreeNode[];
      assert.strictEqual(kindNode.kind, 'kind');
      const objectNodes = provider.getChildren(kindNode) as TreeNode[];
      assert.strictEqual(objectNodes.length, 2, 'two distinct AL objects expected');

      const labels = new Map<string, string>();
      for (const obj of objectNodes) {
        assert.strictEqual(obj.kind, 'object');
        const [event] = provider.getChildren(obj) as TreeNode[];
        labels.set(
          (obj as Extract<TreeNode, { kind: 'object' }>).objectName,
          provider.getTreeItem(event).label as string
        );
      }
      assert.strictEqual(labels.get('Sales-Post'), 'OnAfterPostSalesDoc · (2)');
      assert.strictEqual(labels.get('NoListenersHere'), 'OnIdle · (0)');
    } finally {
      store.dispose();
    }
  });

  test('trigger publishers coexist with integration publishers under the same AppNode but in different KindNodes', () => {
    const store = new EventIndexStore();
    try {
      const fileUri = vscode.Uri.parse('file:///workspace/MyTable.al');
      const integration = makePublisher('codeunit', 'Sales-Post', 'OnAfterPostSalesDoc', {
        appId: 'Microsoft.SalesMgmt'
      });
      const trigger = makePublisher('table', 'MyTable', 'OnAfterInsertEvent', {
        kind: 'trigger',
        sourceUri: fileUri,
        appId: 'Microsoft.SalesMgmt'
      });
      store.set({ publishers: [integration, trigger], subscribers: [], appMeta: new Map() });

      const provider = new EventTreeDataProvider(store);
      const roots = provider.getChildren() as TreeNode[];
      assert.strictEqual(roots.length, 1, 'single app bucket — both share appId');

      const kindNodes = provider.getChildren(roots[0]) as TreeNode[];
      assert.strictEqual(kindNodes.length, 2, 'one KindNode per ObjectKind under the AppNode');
      const kindLabels = kindNodes.map((n) => provider.getTreeItem(n).label as string);
      // Alphabetical: 'Codeunit' < 'Table'
      assert.deepStrictEqual(kindLabels, ['Codeunit', 'Table']);

      // Each KindNode has its lone ObjectNode with its lone EventNode.
      for (const kn of kindNodes) {
        const objs = provider.getChildren(kn) as TreeNode[];
        assert.strictEqual(objs.length, 1);
        const events = provider.getChildren(objs[0]) as TreeNode[];
        assert.strictEqual(events.length, 1);
      }
    } finally {
      store.dispose();
    }
  });

  test('empty store yields a single placeholder node with `Refresh Index` text and collapsibleState None', () => {
    const store = new EventIndexStore();
    try {
      const provider = new EventTreeDataProvider(store);
      const roots = provider.getChildren() as TreeNode[];
      assert.strictEqual(roots.length, 1);
      assert.strictEqual(roots[0].kind, 'empty');

      const item = provider.getTreeItem(roots[0]);
      assert.ok(typeof item.label === 'string' && item.label.includes('Refresh Index'),
        `expected placeholder to mention 'Refresh Index', got: ${String(item.label)}`);
      assert.strictEqual(item.collapsibleState, vscode.TreeItemCollapsibleState.None);
    } finally {
      store.dispose();
    }
  });

  test('refresh() fires _onDidChangeTreeData (the bridge wired by registerTreeView via store.onDidChange)', () => {
    const store = new EventIndexStore();
    try {
      const provider = new EventTreeDataProvider(store);
      let fired = 0;
      provider.onDidChangeTreeData(() => fired++);

      // Mirror registerTreeView's wiring: store.onDidChange → provider.refresh()
      const sub = store.onDidChange(() => provider.refresh());
      try {
        store.set({
          publishers: [makePublisher('codeunit', 'C', 'OnX')],
          subscribers: [],
          appMeta: new Map()
        });
        assert.strictEqual(fired, 1, 'TreeDataProvider must refresh when the store changes');

        // Also verify refresh() can be called directly (CodeLens-style explicit invalidation).
        provider.refresh();
        assert.strictEqual(fired, 2, 'direct refresh() call must also fire _onDidChangeTreeData');
      } finally {
        sub.dispose();
      }
    } finally {
      store.dispose();
    }
  });

  test('app bucket with appMeta uses Name as label and Publisher as description; appId in tooltip', () => {
    const store = new EventIndexStore();
    try {
      const appId = 'a48bafe5-7032-4f02-87d2-43e2d5e4f1ea';
      const appMeta = new Map<string, AppMeta>([
        [appId, { appId, name: 'Sample App', appPublisher: 'Acme Corp' }]
      ]);
      store.set({
        publishers: [
          makePublisher('codeunit', 'Sample Calc', 'OnAfterPostSample', { appId })
        ],
        subscribers: [],
        appMeta
      });

      const provider = new EventTreeDataProvider(store);
      const [appNode] = provider.getChildren() as TreeNode[];
      assert.strictEqual(appNode.kind, 'app');
      assert.strictEqual((appNode as Extract<TreeNode, { kind: 'app' }>).label, 'Sample App',
        'label should be the friendly Name from appMeta, not the GUID');

      const item = provider.getTreeItem(appNode);
      assert.strictEqual(item.label, 'Sample App');
      assert.strictEqual(item.description, 'Acme Corp', 'description should carry the appPublisher');
      assert.ok(typeof item.tooltip === 'string', 'tooltip should be a string');
      assert.ok((item.tooltip as string).includes('Acme Corp — Sample App'),
        `tooltip should include "Acme Corp — Sample App"; got: ${item.tooltip}`);
      assert.ok((item.tooltip as string).includes(`appId: ${appId}`),
        `tooltip should include "appId: ${appId}"; got: ${item.tooltip}`);
    } finally {
      store.dispose();
    }
  });

  test('app bucket with no appMeta entry falls back to the appId GUID label', () => {
    const store = new EventIndexStore();
    try {
      const appId = '00000000-0000-0000-0000-000000000999';
      store.set({
        publishers: [makePublisher('codeunit', 'Foo', 'OnBar', { appId })],
        subscribers: [],
        appMeta: new Map()
      });

      const provider = new EventTreeDataProvider(store);
      const [appNode] = provider.getChildren() as TreeNode[];
      assert.strictEqual((appNode as Extract<TreeNode, { kind: 'app' }>).label, appId);

      const item = provider.getTreeItem(appNode);
      assert.strictEqual(item.description, undefined,
        'no appPublisher → no description (rendered as empty in the UI)');
    } finally {
      store.dispose();
    }
  });

  test('sort: `(workspace)` first, then case-insensitive alphabetical by displayed label (mix of friendly and GUID)', () => {
    const store = new EventIndexStore();
    try {
      const idMicrosoft = '437dbf0e-84ff-417a-965d-ed2bb9650972';
      const idAcme      = 'a48bafe5-7032-4f02-87d2-43e2d5e4f1ea';
      const idAnonymous = '00000000-0000-0000-0000-deadbeefcafe';
      const appMeta = new Map<string, AppMeta>([
        [idMicrosoft, { appId: idMicrosoft, name: 'business foundation', appPublisher: 'Microsoft' }],
        [idAcme,      { appId: idAcme,      name: 'Sample App',          appPublisher: 'Acme Corp' }]
      ]);
      store.set({
        publishers: [
          makePublisher('codeunit', 'A',  'OnA', { appId: idMicrosoft }),
          makePublisher('codeunit', 'B',  'OnB', { appId: idAcme }),
          makePublisher('codeunit', 'C',  'OnC', { appId: idAnonymous }),
          makePublisher('codeunit', 'W',  'OnW') // workspace
        ],
        subscribers: [],
        appMeta
      });

      const provider = new EventTreeDataProvider(store);
      const roots = provider.getChildren() as TreeNode[];
      const labels = roots
        .filter((n): n is Extract<TreeNode, { kind: 'app' }> => n.kind === 'app')
        .map((n) => n.label);

      assert.strictEqual(labels[0], '(workspace)', '(workspace) must come first');
      assert.deepStrictEqual(labels.slice(1), [
        idAnonymous,           // '00000000-...' sorts before 'b' / 's'
        'business foundation', // case-insensitive: 'b' < 's'
        'Sample App'
      ], `sort order wrong; got: ${JSON.stringify(labels)}`);
    } finally {
      store.dispose();
    }
  });

  test('event leaf carries `alEventLens.revealPublisher` command with the publisher as identity argument', () => {
    const store = new EventIndexStore();
    try {
      const pub = makePublisher('codeunit', 'Sales-Post', 'OnAfterPostSalesDoc');
      store.set({ publishers: [pub], subscribers: [], appMeta: new Map() });

      const provider = new EventTreeDataProvider(store);
      const [appNode] = provider.getChildren() as TreeNode[];
      const [kindNode] = provider.getChildren(appNode) as TreeNode[];
      const [objectNode] = provider.getChildren(kindNode) as TreeNode[];
      const [event] = provider.getChildren(objectNode) as TreeNode[];
      const item = provider.getTreeItem(event);

      assert.ok(item.command, 'event leaf must carry a command');
      assert.strictEqual(item.command.command, 'alEventLens.revealPublisher');
      assert.strictEqual(item.command.title, 'Reveal Publisher');
      assert.ok(Array.isArray(item.command.arguments), 'command.arguments must be an array');
      assert.strictEqual(item.command.arguments.length, 1);
      assert.strictEqual(item.command.arguments[0], pub,
        'argument must be the same publisher instance (identity, not copy)');
    } finally {
      store.dispose();
    }
  });

  test('AppNode children are KindNodes — one per ObjectKind, sorted alphabetically by display label', () => {
    const store = new EventIndexStore();
    try {
      store.set({
        publishers: [
          makePublisher('xmlport',         'Foo',    'OnX'),
          makePublisher('codeunit',        'Bar',    'OnB'),
          makePublisher('table',           'Baz',    'OnT'),
          makePublisher('codeunit',        'Qux',    'OnC'),
          makePublisher('pageextension',   'PageX',  'OnP')
        ],
        subscribers: [],
        appMeta: new Map()
      });

      const provider = new EventTreeDataProvider(store);
      const [appNode] = provider.getChildren() as TreeNode[];
      const kindNodes = provider.getChildren(appNode) as TreeNode[];
      assert.strictEqual(kindNodes.length, 4, 'one KindNode per distinct kind (two codeunits collapse)');
      const labels = kindNodes.map((n) => provider.getTreeItem(n).label as string);
      assert.deepStrictEqual(labels, ['Codeunit', 'PageExtension', 'Table', 'XmlPort'],
        'KindNodes must be sorted alphabetically by formatted label');
    } finally {
      store.dispose();
    }
  });

  test('KindNode children are ObjectNodes — one per owner.name, sorted case-insensitively', () => {
    const store = new EventIndexStore();
    try {
      store.set({
        publishers: [
          makePublisher('codeunit', 'zeta',  'OnZ'),
          makePublisher('codeunit', 'Alpha', 'OnA1'),
          makePublisher('codeunit', 'Alpha', 'OnA2'),
          makePublisher('codeunit', 'beta',  'OnB')
        ],
        subscribers: [],
        appMeta: new Map()
      });

      const provider = new EventTreeDataProvider(store);
      const [appNode] = provider.getChildren() as TreeNode[];
      const [kindNode] = provider.getChildren(appNode) as TreeNode[];
      const objectNodes = provider.getChildren(kindNode) as TreeNode[];
      const names = objectNodes
        .map((n) => (n as Extract<TreeNode, { kind: 'object' }>).objectName);
      assert.deepStrictEqual(names, ['Alpha', 'beta', 'zeta'],
        'ObjectNodes must be sorted case-insensitively by object name');

      const labels = objectNodes.map((n) => provider.getTreeItem(n).label as string);
      assert.deepStrictEqual(labels, ['Alpha', 'beta', 'zeta'],
        'ObjectNode TreeItem label is the bare object name (no kind prefix, no quotes)');
    } finally {
      store.dispose();
    }
  });

  test('KindNode and ObjectNode TreeItems carry an aggregate event-count description', () => {
    const store = new EventIndexStore();
    try {
      store.set({
        publishers: [
          // Codeunit / Sales-Post · 3 events
          makePublisher('codeunit', 'Sales-Post', 'OnAfter'),
          makePublisher('codeunit', 'Sales-Post', 'OnBefore'),
          makePublisher('codeunit', 'Sales-Post', 'OnDuring'),
          // Codeunit / Item-Post · 1 event
          makePublisher('codeunit', 'Item-Post', 'OnAfter'),
          // Table / Customer · 2 events
          makePublisher('table', 'Customer', 'OnInsert'),
          makePublisher('table', 'Customer', 'OnDelete')
        ],
        subscribers: [],
        appMeta: new Map()
      });

      const provider = new EventTreeDataProvider(store);
      const [appNode] = provider.getChildren() as TreeNode[];
      const kindNodes = provider.getChildren(appNode) as TreeNode[];
      const kindLabels = new Map<string, vscode.TreeItem>();
      for (const kn of kindNodes) {
        const item = provider.getTreeItem(kn);
        kindLabels.set(item.label as string, item);
      }
      assert.strictEqual(kindLabels.get('Codeunit')!.description, '4', 'Codeunit has 4 events total');
      assert.strictEqual(kindLabels.get('Table')!.description, '2', 'Table has 2 events total');

      const codeunitKindNode = kindNodes.find(
        (n) => provider.getTreeItem(n).label === 'Codeunit'
      ) as Extract<TreeNode, { kind: 'kind' }>;
      const objectNodes = provider.getChildren(codeunitKindNode) as TreeNode[];
      const objectByName = new Map<string, vscode.TreeItem>();
      for (const on of objectNodes) {
        const item = provider.getTreeItem(on);
        objectByName.set(item.label as string, item);
      }
      assert.strictEqual(objectByName.get('Sales-Post')!.description, '3');
      assert.strictEqual(objectByName.get('Item-Post')!.description, '1');
    } finally {
      store.dispose();
    }
  });

  test('ObjectNode children are EventNodes sorted by event name; multiple events on the same object live together', () => {
    const store = new EventIndexStore();
    try {
      store.set({
        publishers: [
          makePublisher('codeunit', 'Sales-Post', 'OnBeforePostSalesDoc'),
          makePublisher('codeunit', 'Sales-Post', 'OnAfterPostSalesDoc')
        ],
        subscribers: [],
        appMeta: new Map()
      });

      const provider = new EventTreeDataProvider(store);
      const [appNode] = provider.getChildren() as TreeNode[];
      const [kindNode] = provider.getChildren(appNode) as TreeNode[];
      const [objectNode] = provider.getChildren(kindNode) as TreeNode[];
      const events = provider.getChildren(objectNode) as TreeNode[];
      const labels = events.map((n) => provider.getTreeItem(n).label as string);
      assert.deepStrictEqual(labels, [
        'OnAfterPostSalesDoc · (0)',
        'OnBeforePostSalesDoc · (0)'
      ], 'events sorted alphabetically and labeled `<event> · (N)`');
    } finally {
      store.dispose();
    }
  });
});

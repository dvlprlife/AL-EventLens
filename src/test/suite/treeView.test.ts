import * as assert from 'assert';
import * as vscode from 'vscode';
import type { EventKind, ObjectKind, Publisher, Subscriber } from '../../al/types';
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
        subscribers: []
      });

      const provider = new EventTreeDataProvider(store);
      const roots = provider.getChildren() as TreeNode[];

      assert.strictEqual(roots.length, 2, 'two app buckets expected');
      assert.strictEqual(roots[0].kind, 'app');
      assert.strictEqual(roots[1].kind, 'app');
      const appRoots = roots as Array<Extract<TreeNode, { kind: 'app' }>>;
      assert.strictEqual(appRoots[0].label, '(workspace)', '(workspace) must come first');
      assert.strictEqual(appRoots[1].label, 'Microsoft.SalesMgmt');
    } finally {
      store.dispose();
    }
  });

  test('publisher leaf label includes the subscriber count `(N)` — both 0 and >0', () => {
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
        ]
      });

      const provider = new EventTreeDataProvider(store);
      const [appNode] = provider.getChildren() as TreeNode[];
      assert.strictEqual(appNode.kind, 'app');
      const leaves = provider.getChildren(appNode) as TreeNode[];

      // Sorted by owner.name then eventName, case-insensitive: 'NoListenersHere', 'Sales-Post'
      assert.strictEqual(leaves.length, 2);
      const labels = leaves.map((n) => provider.getTreeItem(n).label as string);
      const matched = labels.find((l) => l.includes('"Sales-Post"'));
      const unmatched = labels.find((l) => l.includes('"NoListenersHere"'));
      assert.ok(matched && matched.endsWith(' · (2)'), `expected '(2)' suffix, got: ${matched}`);
      assert.ok(unmatched && unmatched.endsWith(' · (0)'), `expected '(0)' suffix, got: ${unmatched}`);
    } finally {
      store.dispose();
    }
  });

  test('trigger publishers appear in the same bucket as integration publishers, with the same label format', () => {
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
      store.set({ publishers: [integration, trigger], subscribers: [] });

      const provider = new EventTreeDataProvider(store);
      const roots = provider.getChildren() as TreeNode[];
      assert.strictEqual(roots.length, 1, 'single app bucket — both share appId');
      const leaves = provider.getChildren(roots[0]) as TreeNode[];
      assert.strictEqual(leaves.length, 2, 'integration and trigger must coexist under the same AppNode');

      const labels = leaves.map((n) => provider.getTreeItem(n).label as string);
      assert.ok(labels.some((l) => l.startsWith('Codeunit::"Sales-Post" · OnAfterPostSalesDoc · (')));
      assert.ok(labels.some((l) => l.startsWith('Table::"MyTable" · OnAfterInsertEvent · (')));
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
          subscribers: []
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

  test('publisher leaf carries `alEventLens.revealPublisher` command with the publisher as identity argument', () => {
    const store = new EventIndexStore();
    try {
      const pub = makePublisher('codeunit', 'Sales-Post', 'OnAfterPostSalesDoc');
      store.set({ publishers: [pub], subscribers: [] });

      const provider = new EventTreeDataProvider(store);
      const [appNode] = provider.getChildren() as TreeNode[];
      const [leaf] = provider.getChildren(appNode) as TreeNode[];
      const item = provider.getTreeItem(leaf);

      assert.ok(item.command, 'leaf must carry a command');
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
});

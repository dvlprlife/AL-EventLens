import * as assert from 'assert';
import * as vscode from 'vscode';
import type { AppMeta, ObjectKind, Subscriber } from '../../al/types';
import { EventIndexStore } from '../../index/store';
import { SubscriberTreeDataProvider, type SubTreeNode } from '../../ui/subscriberTreeView';

// ─── Fixtures ───────────────────────────────────────────────────────────

function makeSubscriber(
  owner: { kind: ObjectKind; name: string; appId?: string },
  target: { kind: ObjectKind; name: string },
  targetEvent: string,
  opts?: { resolved?: boolean; uri?: vscode.Uri; line?: number }
): Subscriber {
  const uri = opts?.uri ?? vscode.Uri.parse('file:///x.al');
  return {
    owner: { kind: owner.kind, name: owner.name, appId: owner.appId },
    target: { kind: target.kind, name: target.name },
    targetEvent,
    location: new vscode.Location(uri, new vscode.Position(opts?.line ?? 0, 0)),
    resolved: opts?.resolved ?? false
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────

suite('ui/subscriberTreeView: SubscriberTreeDataProvider', () => {
  test('groups subscribers by owner appId, `(workspace)` bucket first then alphabetical', () => {
    const store = new EventIndexStore();
    try {
      store.set({
        publishers: [],
        subscribers: [
          makeSubscriber({ kind: 'codeunit', name: 'Sub A', appId: 'Microsoft.Foo' }, { kind: 'codeunit', name: 'Sales-Post' }, 'OnAfterPost'),
          makeSubscriber({ kind: 'codeunit', name: 'Sub B' }, { kind: 'codeunit', name: 'Purch-Post' }, 'OnAfterPurch')
        ],
        appMeta: new Map()
      });

      const provider = new SubscriberTreeDataProvider(store);
      const roots = provider.getChildren() as SubTreeNode[];
      assert.strictEqual(roots.length, 2, 'two app buckets expected');
      const appRoots = roots as Array<Extract<SubTreeNode, { kind: 'app' }>>;
      assert.strictEqual(appRoots[0].label, '(workspace)', '(workspace) must come first');
      assert.strictEqual(appRoots[1].label, 'Microsoft.Foo',
        'no appMeta entry → label falls back to the raw appId');
    } finally {
      store.dispose();
    }
  });

  test('drills app → kind → object → subscriber leaf, with the leaf labeled by its target', () => {
    const store = new EventIndexStore();
    try {
      store.set({
        publishers: [],
        subscribers: [
          makeSubscriber({ kind: 'codeunit', name: 'My Sub' }, { kind: 'codeunit', name: 'Sales-Post' }, 'OnAfterPostSalesDoc')
        ],
        appMeta: new Map()
      });

      const provider = new SubscriberTreeDataProvider(store);
      const [appNode] = provider.getChildren() as SubTreeNode[];
      assert.strictEqual(appNode.kind, 'app');
      const [kindNode] = provider.getChildren(appNode) as SubTreeNode[];
      assert.strictEqual(kindNode.kind, 'kind');
      const [objectNode] = provider.getChildren(kindNode) as SubTreeNode[];
      assert.strictEqual(objectNode.kind, 'object');
      assert.strictEqual((objectNode as Extract<SubTreeNode, { kind: 'object' }>).objectName, 'My Sub');

      const leaves = provider.getChildren(objectNode) as SubTreeNode[];
      assert.strictEqual(leaves.length, 1);
      assert.strictEqual(leaves[0].kind, 'subscriber');
      const item = provider.getTreeItem(leaves[0]);
      assert.strictEqual(item.label, 'Codeunit::"Sales-Post" · OnAfterPostSalesDoc',
        'leaf label is the target identity selector plus the subscribed event');
      assert.strictEqual(item.collapsibleState, vscode.TreeItemCollapsibleState.None);
    } finally {
      store.dispose();
    }
  });

  test('subscriber leaf icon is `pass` (resolved) or `warning` (unresolved), each themed with a color', () => {
    const store = new EventIndexStore();
    try {
      store.set({
        publishers: [],
        subscribers: [
          makeSubscriber({ kind: 'codeunit', name: 'Resolved Sub' }, { kind: 'codeunit', name: 'T' }, 'OnA', { resolved: true }),
          makeSubscriber({ kind: 'codeunit', name: 'Orphan Sub' }, { kind: 'codeunit', name: 'T' }, 'OnB', { resolved: false })
        ],
        appMeta: new Map()
      });

      const provider = new SubscriberTreeDataProvider(store);
      const [appNode] = provider.getChildren() as SubTreeNode[];
      const [kindNode] = provider.getChildren(appNode) as SubTreeNode[];
      const objectNodes = provider.getChildren(kindNode) as SubTreeNode[];
      const iconByName = new Map<string, vscode.ThemeIcon>();
      for (const obj of objectNodes) {
        const [leaf] = provider.getChildren(obj) as SubTreeNode[];
        iconByName.set(
          (obj as Extract<SubTreeNode, { kind: 'object' }>).objectName,
          provider.getTreeItem(leaf).iconPath as vscode.ThemeIcon
        );
      }
      assert.strictEqual(iconByName.get('Resolved Sub')!.id, 'pass');
      assert.strictEqual(iconByName.get('Orphan Sub')!.id, 'warning');
      assert.ok(iconByName.get('Resolved Sub')!.color instanceof vscode.ThemeColor);
      assert.ok(iconByName.get('Orphan Sub')!.color instanceof vscode.ThemeColor);
    } finally {
      store.dispose();
    }
  });

  test('subscriber leaf carries `alEventLens.revealSubscriber` with the subscriber as identity argument', () => {
    const store = new EventIndexStore();
    try {
      const sub = makeSubscriber({ kind: 'codeunit', name: 'My Sub' }, { kind: 'codeunit', name: 'Sales-Post' }, 'OnAfterPost');
      store.set({ publishers: [], subscribers: [sub], appMeta: new Map() });

      const provider = new SubscriberTreeDataProvider(store);
      const [appNode] = provider.getChildren() as SubTreeNode[];
      const [kindNode] = provider.getChildren(appNode) as SubTreeNode[];
      const [objectNode] = provider.getChildren(kindNode) as SubTreeNode[];
      const [leaf] = provider.getChildren(objectNode) as SubTreeNode[];
      const item = provider.getTreeItem(leaf);

      assert.ok(item.command, 'subscriber leaf must carry a command');
      assert.strictEqual(item.command!.command, 'alEventLens.revealSubscriber');
      assert.ok(Array.isArray(item.command!.arguments));
      assert.strictEqual(item.command!.arguments!.length, 1);
      assert.strictEqual(item.command!.arguments![0], sub,
        'argument must be the same subscriber instance (identity, not copy)');
    } finally {
      store.dispose();
    }
  });

  test('kind and object nodes show a `(N)` subscriber count', () => {
    const store = new EventIndexStore();
    try {
      store.set({
        publishers: [],
        subscribers: [
          makeSubscriber({ kind: 'codeunit', name: 'Sub One' }, { kind: 'codeunit', name: 'A' }, 'OnA'),
          makeSubscriber({ kind: 'codeunit', name: 'Sub One' }, { kind: 'codeunit', name: 'B' }, 'OnB'),
          makeSubscriber({ kind: 'codeunit', name: 'Sub Two' }, { kind: 'codeunit', name: 'C' }, 'OnC')
        ],
        appMeta: new Map()
      });

      const provider = new SubscriberTreeDataProvider(store);
      const [appNode] = provider.getChildren() as SubTreeNode[];
      const [kindNode] = provider.getChildren(appNode) as SubTreeNode[];
      assert.strictEqual(provider.getTreeItem(kindNode).description, '(3)',
        'kind node counts every subscriber owned by that kind');

      const objectNodes = provider.getChildren(kindNode) as SubTreeNode[];
      const descByName = new Map<string, string | boolean | undefined>();
      for (const obj of objectNodes) {
        descByName.set(
          (obj as Extract<SubTreeNode, { kind: 'object' }>).objectName,
          provider.getTreeItem(obj).description
        );
      }
      assert.strictEqual(descByName.get('Sub One'), '(2)');
      assert.strictEqual(descByName.get('Sub Two'), '(1)');
    } finally {
      store.dispose();
    }
  });

  test('subscriber leaves under one object sort by target name, then target event', () => {
    const store = new EventIndexStore();
    try {
      store.set({
        publishers: [],
        subscribers: [
          makeSubscriber({ kind: 'codeunit', name: 'My Sub' }, { kind: 'codeunit', name: 'Zeta' }, 'OnZ'),
          makeSubscriber({ kind: 'codeunit', name: 'My Sub' }, { kind: 'codeunit', name: 'Alpha' }, 'OnB'),
          makeSubscriber({ kind: 'codeunit', name: 'My Sub' }, { kind: 'codeunit', name: 'Alpha' }, 'OnA')
        ],
        appMeta: new Map()
      });

      const provider = new SubscriberTreeDataProvider(store);
      const [appNode] = provider.getChildren() as SubTreeNode[];
      const [kindNode] = provider.getChildren(appNode) as SubTreeNode[];
      const [objectNode] = provider.getChildren(kindNode) as SubTreeNode[];
      const labels = (provider.getChildren(objectNode) as SubTreeNode[])
        .map((n) => provider.getTreeItem(n).label as string);
      assert.deepStrictEqual(labels, [
        'Codeunit::"Alpha" · OnA',
        'Codeunit::"Alpha" · OnB',
        'Codeunit::"Zeta" · OnZ'
      ]);
    } finally {
      store.dispose();
    }
  });

  test('kind nodes — one per owner kind, sorted alphabetically by display label', () => {
    const store = new EventIndexStore();
    try {
      store.set({
        publishers: [],
        subscribers: [
          makeSubscriber({ kind: 'table', name: 'T' }, { kind: 'codeunit', name: 'X' }, 'OnA'),
          makeSubscriber({ kind: 'codeunit', name: 'C' }, { kind: 'codeunit', name: 'X' }, 'OnB'),
          makeSubscriber({ kind: 'codeunit', name: 'D' }, { kind: 'codeunit', name: 'X' }, 'OnC')
        ],
        appMeta: new Map()
      });

      const provider = new SubscriberTreeDataProvider(store);
      const [appNode] = provider.getChildren() as SubTreeNode[];
      const labels = (provider.getChildren(appNode) as SubTreeNode[])
        .map((n) => provider.getTreeItem(n).label as string);
      assert.deepStrictEqual(labels, ['Codeunit', 'Table'],
        'one KindNode per distinct kind, sorted by formatted label');
    } finally {
      store.dispose();
    }
  });

  test('workspace projects sort before dependency packages, labeled and iconned from appMeta', () => {
    const store = new EventIndexStore();
    try {
      const wsId = '11111111-1111-1111-1111-111111111111';
      const depId = '33333333-3333-3333-3333-333333333333';
      const appMeta = new Map<string, AppMeta>([
        [wsId, { appId: wsId, name: 'Zeta Project', isWorkspaceApp: true }],
        [depId, { appId: depId, name: 'A Dependency' }]
      ]);
      store.set({
        publishers: [],
        subscribers: [
          makeSubscriber({ kind: 'codeunit', name: 'Dep Sub', appId: depId }, { kind: 'codeunit', name: 'T' }, 'OnA'),
          makeSubscriber({ kind: 'codeunit', name: 'Ws Sub', appId: wsId }, { kind: 'codeunit', name: 'T' }, 'OnB')
        ],
        appMeta
      });

      const provider = new SubscriberTreeDataProvider(store);
      const roots = provider.getChildren() as Array<Extract<SubTreeNode, { kind: 'app' }>>;
      assert.deepStrictEqual(roots.map((n) => n.label), ['Zeta Project', 'A Dependency'],
        'workspace project first even though its name sorts later alphabetically');
      assert.strictEqual(roots[0].isWorkspace, true);
      assert.strictEqual(roots[1].isWorkspace, false);
      assert.strictEqual((provider.getTreeItem(roots[0]).iconPath as vscode.ThemeIcon).id, 'root-folder');
      assert.strictEqual((provider.getTreeItem(roots[1]).iconPath as vscode.ThemeIcon).id, 'package');
    } finally {
      store.dispose();
    }
  });

  test('initialized empty store yields an `empty` placeholder mentioning subscribers and Refresh Index', () => {
    const store = new EventIndexStore();
    try {
      store.set({ publishers: [], subscribers: [], appMeta: new Map() });
      const provider = new SubscriberTreeDataProvider(store);
      const roots = provider.getChildren() as SubTreeNode[];
      assert.strictEqual(roots.length, 1);
      assert.strictEqual(roots[0].kind, 'empty');

      const item = provider.getTreeItem(roots[0]);
      assert.ok(typeof item.label === 'string' && item.label.includes('Refresh Index'),
        `expected placeholder to mention 'Refresh Index', got: ${String(item.label)}`);
      assert.ok(typeof item.label === 'string' && /subscriber/i.test(item.label),
        'empty-state text must mention subscribers, not publishers');
      assert.strictEqual((item.iconPath as vscode.ThemeIcon).id, 'info');
    } finally {
      store.dispose();
    }
  });

  test('uninitialized empty store yields an `indexing` placeholder with the spinning sync icon', () => {
    const store = new EventIndexStore();
    try {
      const provider = new SubscriberTreeDataProvider(store);
      const roots = provider.getChildren() as SubTreeNode[];
      assert.strictEqual(roots.length, 1);
      assert.strictEqual(roots[0].kind, 'indexing');
      const item = provider.getTreeItem(roots[0]);
      assert.strictEqual((item.iconPath as vscode.ThemeIcon).id, 'sync~spin');
    } finally {
      store.dispose();
    }
  });

  test('refresh() fires onDidChangeTreeData (the bridge wired by registerSubscriberTreeView)', () => {
    const store = new EventIndexStore();
    try {
      const provider = new SubscriberTreeDataProvider(store);
      let fired = 0;
      provider.onDidChangeTreeData(() => fired++);

      const sub = store.onDidChange(() => provider.refresh());
      try {
        store.set({
          publishers: [],
          subscribers: [makeSubscriber({ kind: 'codeunit', name: 'S' }, { kind: 'codeunit', name: 'T' }, 'OnX')],
          appMeta: new Map()
        });
        assert.strictEqual(fired, 1, 'provider must refresh when the store changes');
        provider.refresh();
        assert.strictEqual(fired, 2, 'direct refresh() must also fire onDidChangeTreeData');
      } finally {
        sub.dispose();
      }
    } finally {
      store.dispose();
    }
  });
});

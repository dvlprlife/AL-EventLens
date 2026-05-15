import * as vscode from 'vscode';
import type { ObjectKind, Publisher, Subscriber } from '../al/types';
import { EventIndexStore } from '../index/store';

// ─── Tree node model ────────────────────────────────────────────────────

/** Root-level grouping node: one per source app (`(workspace)` for the
 *  workspace bucket). */
interface AppNode {
  readonly kind: 'app';
  readonly appId: string;
  readonly label: string;
  readonly publishers: ReadonlyArray<Publisher>;
}

/** Leaf node: a single publisher, with its currently-resolved subscriber count. */
interface PublisherNode {
  readonly kind: 'publisher';
  readonly publisher: Publisher;
  readonly subscriberCount: number;
}

/** Placeholder shown only when the store is fully empty. */
interface EmptyNode {
  readonly kind: 'empty';
}

export type TreeNode = AppNode | PublisherNode | EmptyNode;

// ─── Helpers ────────────────────────────────────────────────────────────

const WORKSPACE_BUCKET = '(workspace)';

/** Mirror of `resolver.ts`'s key — case-insensitive on name and event. */
function matchKey(kind: ObjectKind, name: string, event: string): string {
  return `${kind} ${name.toLowerCase()} ${event.toLowerCase()}`;
}

/** AL kind label-cased for the leaf prefix (`Codeunit`, `TableExtension`, ...). */
function formatKind(kind: ObjectKind): string {
  switch (kind) {
    case 'codeunit':         return 'Codeunit';
    case 'table':            return 'Table';
    case 'tableextension':   return 'TableExtension';
    case 'page':             return 'Page';
    case 'pageextension':    return 'PageExtension';
    case 'report':           return 'Report';
    case 'reportextension':  return 'ReportExtension';
    case 'query':            return 'Query';
    case 'xmlport':          return 'XmlPort';
    case 'enum':             return 'Enum';
    case 'enumextension':    return 'EnumExtension';
    case 'permissionset':    return 'PermissionSet';
    case 'interface':        return 'Interface';
  }
}

/** `Codeunit::"Sales-Post" · OnAfterPostSalesDoc · (3)` */
function formatPublisherLabel(p: Publisher, count: number): string {
  return `${formatKind(p.owner.kind)}::"${p.owner.name}" · ${p.eventName} · (${count})`;
}

/** Group publishers by `owner.appId`; `undefined` → `(workspace)` bucket. */
function groupByApp(publishers: ReadonlyArray<Publisher>): AppNode[] {
  const buckets = new Map<string, Publisher[]>();
  for (const p of publishers) {
    const key = p.owner.appId ?? WORKSPACE_BUCKET;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = [];
      buckets.set(key, bucket);
    }
    bucket.push(p);
  }

  const nodes: AppNode[] = [];
  for (const [appId, bucketPublishers] of buckets) {
    nodes.push({ kind: 'app', appId, label: appId, publishers: bucketPublishers });
  }
  // `(workspace)` always first; everything else alphabetical by label.
  nodes.sort((a, b) => {
    if (a.label === WORKSPACE_BUCKET) {
      return b.label === WORKSPACE_BUCKET ? 0 : -1;
    }
    if (b.label === WORKSPACE_BUCKET) {
      return 1;
    }
    return a.label.localeCompare(b.label);
  });
  return nodes;
}

// ─── TreeDataProvider ──────────────────────────────────────────────────

export class EventTreeDataProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<TreeNode | undefined | void>();
  public readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly store: EventIndexStore) {}

  public refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  public getTreeItem(node: TreeNode): vscode.TreeItem {
    if (node.kind === 'empty') {
      return new vscode.TreeItem(
        'No publishers indexed yet — try `AL EventLens: Refresh Index`',
        vscode.TreeItemCollapsibleState.None
      );
    }
    if (node.kind === 'app') {
      return new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Collapsed);
    }
    // publisher leaf
    const item = new vscode.TreeItem(
      formatPublisherLabel(node.publisher, node.subscriberCount),
      vscode.TreeItemCollapsibleState.None
    );
    item.command = {
      command: 'alEventLens.revealPublisher',
      title: 'Reveal Publisher',
      arguments: [node.publisher]
    };
    return item;
  }

  public getChildren(node?: TreeNode): TreeNode[] {
    const index = this.store.get();

    if (!node) {
      if (index.publishers.length === 0) {
        return [{ kind: 'empty' }];
      }
      return groupByApp(index.publishers);
    }

    if (node.kind === 'app') {
      const counts = countSubscribersByPublisherKey(index.subscribers);
      const sorted = [...node.publishers].sort((a, b) => {
        const byOwner = a.owner.name.localeCompare(b.owner.name, undefined, { sensitivity: 'accent' });
        if (byOwner !== 0) {
          return byOwner;
        }
        return a.eventName.localeCompare(b.eventName, undefined, { sensitivity: 'accent' });
      });
      return sorted.map<PublisherNode>((p) => ({
        kind: 'publisher',
        publisher: p,
        subscriberCount: counts.get(matchKey(p.owner.kind, p.owner.name, p.eventName)) ?? 0
      }));
    }

    // publisher / empty leaves have no children
    return [];
  }
}

/** Build a `Map<key, count>` keyed identically to `resolver.ts`. */
function countSubscribersByPublisherKey(
  subscribers: ReadonlyArray<Subscriber>
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const s of subscribers) {
    const k = matchKey(s.target.kind, s.target.name, s.targetEvent);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return counts;
}

/**
 * Register the activity-bar TreeView (`alEventLensView`) listing
 * publishers grouped by source app. The returned disposable owns the
 * `TreeView` itself plus the store subscription, so a single
 * `context.subscriptions.push(...)` cleans up both on extension shutdown.
 */
export function registerTreeView(
  context: vscode.ExtensionContext,
  store: EventIndexStore
): vscode.Disposable {
  void context;
  const provider = new EventTreeDataProvider(store);
  const view = vscode.window.createTreeView('alEventLensView', { treeDataProvider: provider });
  const sub = store.onDidChange(() => provider.refresh());
  return vscode.Disposable.from(view, sub);
}

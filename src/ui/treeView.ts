import * as vscode from 'vscode';
import { formatKind } from '../al/format';
import type { AppMeta, ObjectKind, Publisher } from '../al/types';
import { countSubscribersByPublisherKey, publisherKey } from '../index/match';
import { EventIndexStore } from '../index/store';

// ─── Tree node model ────────────────────────────────────────────────────

/** Root-level grouping: one per source app (`(workspace)` for the
 *  workspace bucket). */
interface AppNode {
  readonly kind: 'app';
  readonly appId: string;
  readonly label: string;
  readonly appPublisher: string;
  readonly publishers: ReadonlyArray<Publisher>;
}

/** Mid-level grouping: one per AL object kind (Codeunit, Table, Page, ...)
 *  within an app bucket. `subscriberCount` is the sum of subscriber counts
 *  across every publisher event in this kind bucket. */
interface KindNode {
  readonly kind: 'kind';
  readonly objectKind: ObjectKind;
  readonly publishers: ReadonlyArray<Publisher>;
  readonly subscriberCount: number;
}

/** Mid-level grouping: one per AL object (e.g. `Sales-Post`) within a kind
 *  bucket. `subscriberCount` is the sum of subscriber counts across every
 *  event on this object. */
interface ObjectNode {
  readonly kind: 'object';
  readonly objectKind: ObjectKind;
  readonly objectName: string;
  readonly publishers: ReadonlyArray<Publisher>;
  readonly subscriberCount: number;
}

/** Leaf: a single publisher event, with its live subscriber count. */
interface EventNode {
  readonly kind: 'event';
  readonly publisher: Publisher;
  readonly subscriberCount: number;
}

/** Placeholder shown only when the store is fully empty. */
interface EmptyNode {
  readonly kind: 'empty';
}

export type TreeNode = AppNode | KindNode | ObjectNode | EventNode | EmptyNode;

// ─── Helpers ────────────────────────────────────────────────────────────

const WORKSPACE_BUCKET = '(workspace)';

/** Codicon id for a given AL object kind. Drawn from the standard
 *  vscode.ThemeIcon set so it themes automatically — no extra assets. */
function iconIdForKind(kind: ObjectKind): string {
  switch (kind) {
    case 'codeunit':         return 'symbol-class';
    case 'table':            return 'symbol-struct';
    case 'tableextension':   return 'symbol-struct';
    case 'page':             return 'window';
    case 'pageextension':    return 'window';
    case 'report':           return 'notebook';
    case 'reportextension':  return 'notebook';
    case 'query':            return 'search';
    case 'xmlport':          return 'file-code';
    case 'enum':             return 'symbol-enum';
    case 'enumextension':    return 'symbol-enum';
    case 'permissionset':    return 'lock';
    case 'interface':        return 'symbol-interface';
  }
}

/** Group publishers by `owner.appId`; `undefined` → `(workspace)` bucket.
 *  Resolves friendly names from `appMeta` when available. */
function groupByApp(
  publishers: ReadonlyArray<Publisher>,
  appMeta: ReadonlyMap<string, AppMeta>
): AppNode[] {
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
    if (appId === WORKSPACE_BUCKET) {
      nodes.push({ kind: 'app', appId, label: WORKSPACE_BUCKET, appPublisher: '', publishers: bucketPublishers });
      continue;
    }
    const meta = appMeta.get(appId);
    nodes.push({
      kind: 'app',
      appId,
      label: meta?.name ?? appId,
      appPublisher: meta?.appPublisher ?? '',
      publishers: bucketPublishers
    });
  }
  nodes.sort((a, b) => {
    if (a.label === WORKSPACE_BUCKET) {
      return b.label === WORKSPACE_BUCKET ? 0 : -1;
    }
    if (b.label === WORKSPACE_BUCKET) {
      return 1;
    }
    return a.label.localeCompare(b.label, undefined, { sensitivity: 'accent' });
  });
  return nodes;
}

/** Sum the subscriber count across a publisher set, using the precomputed map. */
function sumSubscribers(
  publishers: ReadonlyArray<Publisher>,
  countByKey: ReadonlyMap<string, number>
): number {
  let total = 0;
  for (const p of publishers) {
    total += countByKey.get(publisherKey(p)) ?? 0;
  }
  return total;
}

/** Group publishers by AL object kind, sorted alphabetically by display label. */
function groupByKind(
  publishers: ReadonlyArray<Publisher>,
  countByKey: ReadonlyMap<string, number>
): KindNode[] {
  const buckets = new Map<ObjectKind, Publisher[]>();
  for (const p of publishers) {
    let bucket = buckets.get(p.owner.kind);
    if (!bucket) {
      bucket = [];
      buckets.set(p.owner.kind, bucket);
    }
    bucket.push(p);
  }
  const nodes: KindNode[] = [];
  for (const [objectKind, bucketPublishers] of buckets) {
    nodes.push({
      kind: 'kind',
      objectKind,
      publishers: bucketPublishers,
      subscriberCount: sumSubscribers(bucketPublishers, countByKey)
    });
  }
  nodes.sort((a, b) => formatKind(a.objectKind).localeCompare(formatKind(b.objectKind)));
  return nodes;
}

/** Group publishers by object name within a single-kind bucket. */
function groupByObject(
  publishers: ReadonlyArray<Publisher>,
  countByKey: ReadonlyMap<string, number>
): ObjectNode[] {
  const buckets = new Map<string, Publisher[]>();
  for (const p of publishers) {
    let bucket = buckets.get(p.owner.name);
    if (!bucket) {
      bucket = [];
      buckets.set(p.owner.name, bucket);
    }
    bucket.push(p);
  }
  const nodes: ObjectNode[] = [];
  for (const [objectName, bucketPublishers] of buckets) {
    nodes.push({
      kind: 'object',
      objectKind: bucketPublishers[0].owner.kind,
      objectName,
      publishers: bucketPublishers,
      subscriberCount: sumSubscribers(bucketPublishers, countByKey)
    });
  }
  nodes.sort((a, b) => a.objectName.localeCompare(b.objectName, undefined, { sensitivity: 'accent' }));
  return nodes;
}

// ─── TreeDataProvider ──────────────────────────────────────────────────

export class EventTreeDataProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<TreeNode | undefined | void>();
  public readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  /** Cached publisher-key → subscriber-count map for the current store state.
   *  Invalidated on `refresh()`; recomputed lazily on first access per cycle. */
  private _counts?: ReadonlyMap<string, number>;

  constructor(private readonly store: EventIndexStore) {}

  public refresh(): void {
    this._counts = undefined;
    this._onDidChangeTreeData.fire();
  }

  private counts(): ReadonlyMap<string, number> {
    if (!this._counts) {
      this._counts = countSubscribersByPublisherKey(this.store.get().subscribers);
    }
    return this._counts;
  }

  public getTreeItem(node: TreeNode): vscode.TreeItem {
    if (node.kind === 'empty') {
      const item = new vscode.TreeItem(
        'No publishers indexed yet — try `AL EventLens: Refresh Index`',
        vscode.TreeItemCollapsibleState.None
      );
      item.iconPath = new vscode.ThemeIcon('info');
      return item;
    }
    if (node.kind === 'app') {
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Collapsed);
      if (node.appPublisher) {
        item.description = node.appPublisher;
      }
      if (node.appId !== WORKSPACE_BUCKET) {
        const tooltipLines: string[] = [];
        if (node.appPublisher) { tooltipLines.push(`${node.appPublisher} — ${node.label}`); }
        else                   { tooltipLines.push(node.label); }
        tooltipLines.push(`appId: ${node.appId}`);
        item.tooltip = tooltipLines.join('\n');
      }
      item.iconPath = new vscode.ThemeIcon('package');
      return item;
    }
    if (node.kind === 'kind') {
      const item = new vscode.TreeItem(formatKind(node.objectKind), vscode.TreeItemCollapsibleState.Collapsed);
      item.description = `(${node.publishers.length} / ${node.subscriberCount})`;
      item.iconPath = new vscode.ThemeIcon(iconIdForKind(node.objectKind));
      return item;
    }
    if (node.kind === 'object') {
      const item = new vscode.TreeItem(node.objectName, vscode.TreeItemCollapsibleState.Collapsed);
      item.description = `(${node.publishers.length} / ${node.subscriberCount})`;
      item.iconPath = new vscode.ThemeIcon('symbol-file');
      return item;
    }
    // event leaf
    const label = `${node.publisher.eventName} · (${node.subscriberCount})`;
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
    item.command = {
      command: 'alEventLens.revealPublisher',
      title: 'Reveal Publisher',
      arguments: [node.publisher]
    };
    item.iconPath = new vscode.ThemeIcon('symbol-event');
    return item;
  }

  public getChildren(node?: TreeNode): TreeNode[] {
    const index = this.store.get();

    if (!node) {
      if (index.publishers.length === 0) {
        return [{ kind: 'empty' }];
      }
      return groupByApp(index.publishers, index.appMeta);
    }

    if (node.kind === 'app') {
      return groupByKind(node.publishers, this.counts());
    }

    if (node.kind === 'kind') {
      return groupByObject(node.publishers, this.counts());
    }

    if (node.kind === 'object') {
      const counts = this.counts();
      const sorted = [...node.publishers].sort((a, b) =>
        a.eventName.localeCompare(b.eventName, undefined, { sensitivity: 'accent' })
      );
      return sorted.map<EventNode>((p) => ({
        kind: 'event',
        publisher: p,
        subscriberCount: counts.get(publisherKey(p)) ?? 0
      }));
    }

    // event / empty leaves have no children
    return [];
  }
}

/**
 * Register the activity-bar TreeView (`alEventLensView`) listing
 * publishers grouped by source app, then by AL object kind, then by
 * object name, then by event. The returned disposable owns the
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

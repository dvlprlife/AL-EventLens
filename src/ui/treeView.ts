import * as vscode from 'vscode';
import { formatKind } from '../al/format';
import type { AppMeta, ObjectKind, Publisher } from '../al/types';
import { countSubscribersByPublisherKey, publisherKey } from '../index/match';
import { EventIndexStore } from '../index/store';

// ─── Tree node model ────────────────────────────────────────────────────

/** Root-level grouping: one per source app. Workspace AL projects (each
 *  `app.json`) and dependency `.alpackages/*.app` packages both get a node;
 *  the literal `(workspace)` bucket survives only as the fallback for loose
 *  `.al` files under no `app.json`. */
interface AppNode {
  readonly kind: 'app';
  readonly appId: string;
  readonly label: string;
  readonly appPublisher: string;
  /** True for a workspace AL project and for the loose-file `(workspace)`
   *  fallback bucket; false for a `.alpackages/*.app` dependency package.
   *  Drives the workspace-first sort and the `root-folder` icon. */
  readonly isWorkspace: boolean;
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
 *  event on this object. `appId` carries the owning bucket so a click can
 *  drive the panel's app+kind+object filter from a single payload. */
interface ObjectNode {
  readonly kind: 'object';
  readonly objectKind: ObjectKind;
  readonly objectName: string;
  readonly appId: string | undefined;
  readonly publishers: ReadonlyArray<Publisher>;
  readonly subscriberCount: number;
}

/** Leaf: a single publisher event, with its live subscriber count. */
interface EventNode {
  readonly kind: 'event';
  readonly publisher: Publisher;
  readonly subscriberCount: number;
}

/** Placeholder shown only when the store is fully empty AFTER initial
 *  indexing has resolved. */
interface EmptyNode {
  readonly kind: 'empty';
}

/** Placeholder shown while the initial full-pass index is still running.
 *  Distinguishes "indexing hasn't finished yet" from "indexed and empty"
 *  so the tree doesn't suggest `AL EventLens: Refresh Index` while the
 *  status bar is already reporting progress on the first scan. */
interface IndexingNode {
  readonly kind: 'indexing';
}

export type TreeNode = AppNode | KindNode | ObjectNode | EventNode | EmptyNode | IndexingNode;

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

/** Group publishers by `owner.appId`. A real `appId` buckets per app (a
 *  workspace AL project or a dependency package); `undefined` falls back to
 *  the literal `(workspace)` bucket for loose `.al` files under no
 *  `app.json`. Friendly names come from `appMeta`; `appMeta.isWorkspaceApp`
 *  marks an `appId` as a workspace project. Workspace projects sort before
 *  dependency packages, case-insensitive alphabetical within each group. */
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
      nodes.push({
        kind: 'app',
        appId,
        label: WORKSPACE_BUCKET,
        appPublisher: '',
        isWorkspace: true,
        publishers: bucketPublishers
      });
      continue;
    }
    const meta = appMeta.get(appId);
    nodes.push({
      kind: 'app',
      appId,
      label: meta?.name ?? appId,
      appPublisher: meta?.appPublisher ?? '',
      isWorkspace: meta?.isWorkspaceApp === true,
      publishers: bucketPublishers
    });
  }
  nodes.sort((a, b) => {
    // Workspace projects (and the loose-file fallback bucket) first.
    if (a.isWorkspace !== b.isWorkspace) {
      return a.isWorkspace ? -1 : 1;
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
      appId: bucketPublishers[0].owner.appId,
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
    if (node.kind === 'indexing') {
      const item = new vscode.TreeItem(
        'Indexing workspace…',
        vscode.TreeItemCollapsibleState.None
      );
      // `sync~spin` is VS Code's spinning sync codicon — matches the
      // status-bar progress indicator that's running in parallel.
      item.iconPath = new vscode.ThemeIcon('sync~spin');
      return item;
    }
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
      // The literal `(workspace)` fallback bucket has no real appId, so no
      // tooltip. A named workspace project carries a GUID and gets one,
      // same as a dependency package.
      if (node.appId !== WORKSPACE_BUCKET) {
        const tooltipLines: string[] = [];
        if (node.appPublisher) { tooltipLines.push(`${node.appPublisher} — ${node.label}`); }
        else                   { tooltipLines.push(node.label); }
        tooltipLines.push(`appId: ${node.appId}`);
        item.tooltip = tooltipLines.join('\n');
      }
      // Workspace AL projects (and the loose-file fallback bucket) use the
      // `root-folder` codicon; dependency packages keep `package`.
      item.iconPath = new vscode.ThemeIcon(node.isWorkspace ? 'root-folder' : 'package');
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
      // Clicking the row reveals the panel and filters it to this object's
      // events. The chevron still toggles expand/collapse independently.
      item.command = {
        command: 'alEventLens.revealObject',
        title: 'Reveal Object in Panel',
        arguments: [{ kind: node.objectKind, name: node.objectName, appId: node.appId }]
      };
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
        return [{ kind: this.store.isInitialized ? 'empty' : 'indexing' }];
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
export function registerTreeView(store: EventIndexStore): vscode.Disposable {
  const provider = new EventTreeDataProvider(store);
  const view = vscode.window.createTreeView('alEventLensView', { treeDataProvider: provider });
  const sub = store.onDidChange(() => provider.refresh());
  return vscode.Disposable.from(view, sub);
}

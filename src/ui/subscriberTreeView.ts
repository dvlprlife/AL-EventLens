import * as vscode from 'vscode';
import { formatKind } from '../al/format';
import type { AppMeta, ObjectKind, Subscriber } from '../al/types';
import { EventIndexStore } from '../index/store';
import { iconIdForKind, WORKSPACE_BUCKET } from './treeView';

// ─── Tree node model ────────────────────────────────────────────────────

/** Root-level grouping: one per app that *owns* subscribers. Workspace AL
 *  projects and (where bundled `src/**` is present) dependency `.app`
 *  packages both get a node; the literal `(workspace)` bucket survives only
 *  as the fallback for loose `.al` files under no `app.json`. */
interface SubAppNode {
  readonly kind: 'app';
  readonly appId: string;
  readonly label: string;
  readonly appPublisher: string;
  readonly isWorkspace: boolean;
  readonly subscribers: ReadonlyArray<Subscriber>;
}

/** Mid-level grouping: one per owning AL object kind within an app bucket. */
interface SubKindNode {
  readonly kind: 'kind';
  readonly objectKind: ObjectKind;
  readonly subscribers: ReadonlyArray<Subscriber>;
}

/** Mid-level grouping: one per owning AL object within a kind bucket. */
interface SubObjectNode {
  readonly kind: 'object';
  readonly objectKind: ObjectKind;
  readonly objectName: string;
  readonly subscribers: ReadonlyArray<Subscriber>;
}

/** Leaf: a single subscriber, labeled by the target event it listens to. */
interface SubscriberNode {
  readonly kind: 'subscriber';
  readonly subscriber: Subscriber;
}

/** Placeholder shown only when the store is fully empty AFTER initial
 *  indexing has resolved. */
interface EmptyNode {
  readonly kind: 'empty';
}

/** Placeholder shown while the initial full-pass index is still running. */
interface IndexingNode {
  readonly kind: 'indexing';
}

export type SubTreeNode =
  | SubAppNode
  | SubKindNode
  | SubObjectNode
  | SubscriberNode
  | EmptyNode
  | IndexingNode;

// ─── Helpers ────────────────────────────────────────────────────────────

/** Group subscribers by `owner.appId`, mirroring `groupByApp` in
 *  `treeView.ts`: `undefined` appId falls back to the `(workspace)` bucket,
 *  friendly names come from `appMeta`, and workspace projects sort before
 *  dependency packages (case-insensitive alphabetical within each group). */
function groupByApp(
  subscribers: ReadonlyArray<Subscriber>,
  appMeta: ReadonlyMap<string, AppMeta>
): SubAppNode[] {
  const buckets = new Map<string, Subscriber[]>();
  for (const s of subscribers) {
    const key = s.owner.appId ?? WORKSPACE_BUCKET;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = [];
      buckets.set(key, bucket);
    }
    bucket.push(s);
  }

  const nodes: SubAppNode[] = [];
  for (const [appId, bucketSubscribers] of buckets) {
    if (appId === WORKSPACE_BUCKET) {
      nodes.push({
        kind: 'app',
        appId,
        label: WORKSPACE_BUCKET,
        appPublisher: '',
        isWorkspace: true,
        subscribers: bucketSubscribers
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
      subscribers: bucketSubscribers
    });
  }
  nodes.sort((a, b) => {
    if (a.isWorkspace !== b.isWorkspace) {
      return a.isWorkspace ? -1 : 1;
    }
    return a.label.localeCompare(b.label, undefined, { sensitivity: 'accent' });
  });
  return nodes;
}

/** Group subscribers by owning AL object kind, sorted by display label. */
function groupByKind(subscribers: ReadonlyArray<Subscriber>): SubKindNode[] {
  const buckets = new Map<ObjectKind, Subscriber[]>();
  for (const s of subscribers) {
    let bucket = buckets.get(s.owner.kind);
    if (!bucket) {
      bucket = [];
      buckets.set(s.owner.kind, bucket);
    }
    bucket.push(s);
  }
  const nodes: SubKindNode[] = [];
  for (const [objectKind, bucketSubscribers] of buckets) {
    nodes.push({ kind: 'kind', objectKind, subscribers: bucketSubscribers });
  }
  nodes.sort((a, b) => formatKind(a.objectKind).localeCompare(formatKind(b.objectKind)));
  return nodes;
}

/** Group subscribers by owning object name within a single-kind bucket. AL
 *  identifiers are case-insensitive, so the bucket key is lowercased to
 *  merge variants like `MyCu` and `mycu`; the displayed label keeps the
 *  first-seen raw casing so the tree mirrors the user's source. */
function groupByObject(subscribers: ReadonlyArray<Subscriber>): SubObjectNode[] {
  const buckets = new Map<string, { displayName: string; subscribers: Subscriber[] }>();
  for (const s of subscribers) {
    const key = s.owner.name.toLowerCase();
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { displayName: s.owner.name, subscribers: [] };
      buckets.set(key, bucket);
    }
    bucket.subscribers.push(s);
  }
  const nodes: SubObjectNode[] = [];
  for (const { displayName, subscribers: bucketSubscribers } of buckets.values()) {
    nodes.push({
      kind: 'object',
      objectKind: bucketSubscribers[0].owner.kind,
      objectName: displayName,
      subscribers: bucketSubscribers
    });
  }
  nodes.sort((a, b) => a.objectName.localeCompare(b.objectName, undefined, { sensitivity: 'accent' }));
  return nodes;
}

/** Identity selector for a subscriber's target — e.g. `Codeunit::"Sales-Post"`. */
function targetLabel(s: Subscriber): string {
  return `${formatKind(s.target.kind)}::"${s.target.name}"`;
}

/** Identity selector for a subscriber's owner — e.g. `Codeunit::"My Sub"`. */
function ownerLabel(s: Subscriber): string {
  return `${formatKind(s.owner.kind)}::"${s.owner.name}"`;
}

// ─── TreeDataProvider ──────────────────────────────────────────────────

export class SubscriberTreeDataProvider implements vscode.TreeDataProvider<SubTreeNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<SubTreeNode | undefined | void>();
  public readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly store: EventIndexStore) {}

  public refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  /** Dispose the change-event emitter on shutdown. Mirrors the CodeLens
   *  provider; included in `registerSubscriberTreeView`'s `Disposable.from`. */
  public dispose(): void {
    this._onDidChangeTreeData.dispose();
  }

  public getTreeItem(node: SubTreeNode): vscode.TreeItem {
    if (node.kind === 'indexing') {
      const item = new vscode.TreeItem(
        'Indexing workspace…',
        vscode.TreeItemCollapsibleState.None
      );
      item.iconPath = new vscode.ThemeIcon('sync~spin');
      return item;
    }
    if (node.kind === 'empty') {
      const item = new vscode.TreeItem(
        'No subscribers indexed yet — try `AL EventLens: Refresh Index`',
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
      item.iconPath = new vscode.ThemeIcon(node.isWorkspace ? 'root-folder' : 'package');
      return item;
    }
    if (node.kind === 'kind') {
      const item = new vscode.TreeItem(formatKind(node.objectKind), vscode.TreeItemCollapsibleState.Collapsed);
      item.description = `(${node.subscribers.length})`;
      item.iconPath = new vscode.ThemeIcon(iconIdForKind(node.objectKind));
      return item;
    }
    if (node.kind === 'object') {
      const item = new vscode.TreeItem(node.objectName, vscode.TreeItemCollapsibleState.Collapsed);
      item.description = `(${node.subscribers.length})`;
      item.iconPath = new vscode.ThemeIcon('symbol-file');
      return item;
    }
    // subscriber leaf
    const s = node.subscriber;
    const item = new vscode.TreeItem(
      `${targetLabel(s)} · ${s.targetEvent}`,
      vscode.TreeItemCollapsibleState.None
    );
    const loc = s.location;
    // `Uri.fsPath` is meaningful only for `file:` URIs. Subscribers parsed
    // from a packaged `.app`'s bundled source carry the synthetic
    // `al-eventlens-app:` scheme (see indexer.ts), whose `.fsPath` getter
    // strips the scheme and backslash-mangles the POSIX path on Windows —
    // and is meaningless on VS Code Web. Fall back to the clean `.path`.
    const filePath = loc.uri.scheme === 'file' ? loc.uri.fsPath : loc.uri.path;
    const fileLine = `${filePath}:${loc.range.start.line + 1}`;
    item.tooltip = [
      `Owner: ${ownerLabel(s)}`,
      `Target: ${targetLabel(s)} · ${s.targetEvent}`,
      s.resolved
        ? 'Status: Resolved'
        : 'Status: Unresolved — target app missing from .alpackages',
      fileLine
    ].join('\n');
    item.iconPath = s.resolved
      ? new vscode.ThemeIcon('pass', new vscode.ThemeColor('charts.green'))
      : new vscode.ThemeIcon('warning', new vscode.ThemeColor('charts.yellow'));
    item.command = {
      command: 'alEventLens.revealSubscriber',
      title: 'Reveal Subscriber',
      arguments: [s]
    };
    return item;
  }

  public getChildren(node?: SubTreeNode): SubTreeNode[] {
    const index = this.store.get();

    if (!node) {
      if (index.subscribers.length === 0) {
        return [{ kind: this.store.isInitialized ? 'empty' : 'indexing' }];
      }
      return groupByApp(index.subscribers, index.appMeta);
    }

    if (node.kind === 'app') {
      return groupByKind(node.subscribers);
    }

    if (node.kind === 'kind') {
      return groupByObject(node.subscribers);
    }

    if (node.kind === 'object') {
      const sorted = [...node.subscribers].sort((a, b) => {
        const byTarget = a.target.name.localeCompare(b.target.name, undefined, { sensitivity: 'accent' });
        if (byTarget !== 0) { return byTarget; }
        return a.targetEvent.localeCompare(b.targetEvent, undefined, { sensitivity: 'accent' });
      });
      return sorted.map<SubscriberNode>((s) => ({ kind: 'subscriber', subscriber: s }));
    }

    // subscriber / empty / indexing leaves have no children
    return [];
  }
}

/**
 * Register the activity-bar TreeView (`alEventLensSubscribersView`) listing
 * subscribers grouped by owning app, then by AL object kind, then by object
 * name, then by subscribed event. Renders below the Publishers view in the
 * shared `alEventLens` container. The returned disposable owns the
 * `TreeView` plus the store subscription.
 */
export function registerSubscriberTreeView(store: EventIndexStore): vscode.Disposable {
  const provider = new SubscriberTreeDataProvider(store);
  const view = vscode.window.createTreeView('alEventLensSubscribersView', { treeDataProvider: provider });
  // Refresh on both a full re-index and an incremental file save.
  const sub = store.onDidChange(() => provider.refresh());
  const fileSub = store.onDidUpdateFile(() => provider.refresh());
  return vscode.Disposable.from(view, sub, fileSub, provider);
}

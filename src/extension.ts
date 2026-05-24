import * as vscode from 'vscode';
import { getSelectedPublisher, openPanel, postRevealObjectToPanel, postRevealSubscriberToPanel } from './ui/panel';
import { registerTreeView } from './ui/treeView';
import { registerSubscriberTreeView } from './ui/subscriberTreeView';
import { registerCodeLens } from './ui/codelens';
import { runExportMermaid } from './commands/exportMermaid';
import { registerSaveWatcher } from './index/watcher';
import { registerWorkspaceFolderReindex } from './index/folderWatcher';
import { hasAnyGenerationCommitted, runIndexAndCommit } from './index/reindex';
import { EventIndexStore } from './index/store';
import type { ObjectRef, Publisher, Subscriber } from './al/types';
import { reviveRange } from './util/reviveLocation';

export function activate(context: vscode.ExtensionContext): void {
  const store = new EventIndexStore();
  context.subscriptions.push(store);

  const register = (command: string, handler: (...args: unknown[]) => unknown): void => {
    context.subscriptions.push(vscode.commands.registerCommand(command, handler));
  };

  register('alEventLens.openPanel',       () => openPanel(context, store));
  register('alEventLens.refresh',         () => {
    // `runIndexAndCommit` wraps `runIndexWithProgress` with a monotonic
    // generation guard so an in-flight initial pass cannot overwrite the
    // store with an older snapshot after a faster Refresh completes — and
    // vice versa. The last STARTED build wins regardless of resolution
    // order; we still surface errors via the existing log.
    runIndexAndCommit(context, store).done
      .catch((err) => console.error('AL EventLens: refresh failed', err));
  });
  register('alEventLens.revealPublisher', (...args) => {
    if (!args[0]) { return; }
    const publisher = args[0] as Publisher;
    openPanel(context, store);
    // Applies an object filter and selects the event inside it, so the
    // revealed publisher is in view rather than buried in an unfiltered list.
    postRevealObjectToPanel(publisher.owner, publisher);
  });
  register('alEventLens.revealObject', (...args) => {
    if (!args[0]) { return; }
    const owner = args[0] as ObjectRef;
    openPanel(context, store);
    postRevealObjectToPanel(owner);
  });
  register('alEventLens.revealSubscriber', (...args) => {
    if (!args[0]) { return; }
    const subscriber = args[0] as Subscriber;
    openPanel(context, store);
    // Switches the panel to Subscribers mode and selects this subscriber,
    // so it's in view rather than buried in the unfiltered list.
    postRevealSubscriberToPanel(subscriber);
  });
  register('alEventLens.gotoSubscriber',  (...args) => {
    if (!args[0]) { return; }
    // Args may arrive as a real vscode.Location (from CodeLens / Tree) or as
    // a plain {uri, range} bag (structured-cloned from a webview message).
    // Reconstruct both pieces so showTextDocument gets canonical instances.
    const loc = args[0] as { uri: vscode.Uri; range: unknown };
    const uri = vscode.Uri.from(loc.uri);
    // Subscribers parsed from a .app's bundled src/**/*.al carry a synthetic
    // `al-eventlens-app:` URI (see indexer.ts). VS Code can't open that
    // scheme — no FileSystemProvider is registered — so surface a friendly
    // notice instead of letting showTextDocument throw a generic error.
    if (uri.scheme === 'al-eventlens-app') {
      void vscode.window.showInformationMessage(
        'AL EventLens: this subscriber lives inside a packaged .app and its source is not directly openable.'
      );
      return;
    }
    // `reviveRange` tolerates {start,end} OR {_start,_end} OR a degenerate
    // empty object — webview-postMessage strips Range's class getters.
    const range = reviveRange(loc.range);
    void vscode.window.showTextDocument(uri, { selection: range });
  });
  register('alEventLens.exportMermaid',   (...args) => {
    const publisher = (args[0] as Publisher | undefined) ?? getSelectedPublisher();
    void runExportMermaid(publisher, store);
  });

  context.subscriptions.push(registerTreeView(store));
  context.subscriptions.push(registerSubscriberTreeView(store));
  context.subscriptions.push(registerCodeLens(context, store));
  context.subscriptions.push(registerSaveWatcher(context, store));
  context.subscriptions.push(registerWorkspaceFolderReindex(context, store));

  // Fire-and-forget initial index. The result populates the store so the
  // panel, tree, and CodeLens surfaces can render once it completes.
  // On failure, still mark the store initialized (with an empty index) so
  // the tree's `indexing…` placeholder progresses to the real empty-state
  // message rather than spinning forever — but ONLY if NO build has
  // committed yet. If a user-triggered Refresh overlapped this initial
  // pass and successfully committed, `hasAnyGenerationCommitted()` is
  // already true and the fallback would clobber real data. Conversely,
  // if BOTH this initial pass AND a refresh fail, the flag stays false
  // and the fallback still fires so the spinner clears.
  const initial = runIndexAndCommit(context, store);
  initial.done
    .then(({ index, committed }) => {
      if (committed) {
        console.log(`AL EventLens: indexed ${index.publishers.length} publishers, ${index.subscribers.length} subscribers`);
      } else {
        console.log('AL EventLens: initial build superseded - using newer index');
      }
    })
    .catch((err) => {
      console.error('AL EventLens: indexing failed', err);
      if (!hasAnyGenerationCommitted()) {
        store.set({ publishers: [], subscribers: [], appMeta: new Map() });
      }
    });
}

export function deactivate(): void {
  // nothing to clean up; all disposables are in context.subscriptions
}

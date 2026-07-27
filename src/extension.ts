import * as vscode from 'vscode';
import { getSelectedPublisher, openPanel, postRevealObjectToPanel, postRevealSubscriberToPanel } from './ui/panel';
import { registerTreeView } from './ui/treeView';
import { registerSubscriberTreeView } from './ui/subscriberTreeView';
import { registerCodeLens } from './ui/codelens';
import { runExportMermaid } from './commands/exportMermaid';
import { registerSaveWatcher, resetWatcherStateForReload } from './index/watcher';
import { registerWorkspaceFolderReindex } from './index/folderWatcher';
import { resetExtensionStateForReload, runInitialIndex, runRefreshIndex } from './index/reindex';
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
  // Body lives in `reindex.ts` (last-started-wins ordering + the
  // save-supersession re-issue) so tests drive the real handler.
  register('alEventLens.refresh',         () => { void runRefreshIndex(context, store); });
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
  register('alEventLens.showHandlerUsages', (...args) => {
    // Fired by the handler CodeLens with (handler location, usage locations).
    // Hands off to VS Code's built-in references peek so handler usages get
    // the same UI as any other "find references" result. Both arguments come
    // straight from the provider in-process, so they are real vscode types —
    // no revival needed (unlike `gotoSubscriber`, whose payload can arrive
    // structured-cloned from the webview).
    const at = args[0] as vscode.Location | undefined;
    const usages = args[1] as vscode.Location[] | undefined;
    if (!at || !usages || usages.length === 0) {
      return;
    }
    void vscode.commands.executeCommand(
      'editor.action.showReferences',
      at.uri,
      at.range.start,
      usages
    );
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
  // panel, tree, and CodeLens surfaces can render once it completes. Body
  // lives in `reindex.ts` — including the empty-index failure fallback and
  // why it is gated on `!store.isInitialized` — so the same tests that
  // drive the commit policy drive the real activation call site.
  void runInitialIndex(context, store);
}

export function deactivate(): void {
  // Reset module-scoped generation state so a subsequent `activate()`
  // (Developer: Reload Window doesn't guarantee module re-instantiation)
  // doesn't inherit stale tokens or Map entries from this session.
  // Per-context disposables are in `context.subscriptions` and disposed
  // by VS Code for us.
  resetExtensionStateForReload();
  resetWatcherStateForReload();
}

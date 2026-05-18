import * as vscode from 'vscode';
import { getSelectedPublisher, openPanel, postRevealObjectToPanel } from './ui/panel';
import { registerTreeView } from './ui/treeView';
import { registerCodeLens } from './ui/codelens';
import { runExportMermaid } from './commands/exportMermaid';
import { registerSaveWatcher } from './index/watcher';
import { buildIndex, type EventIndex } from './index/indexer';
import { EventIndexStore } from './index/store';
import type { ObjectRef, Publisher } from './al/types';

export function activate(context: vscode.ExtensionContext): void {
  const store = new EventIndexStore();
  context.subscriptions.push(store);

  const register = (command: string, handler: (...args: unknown[]) => unknown): void => {
    context.subscriptions.push(vscode.commands.registerCommand(command, handler));
  };

  const indexWithProgress = async (): Promise<EventIndex> =>
    vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: 'AL EventLens' },
      async (progress) => buildIndex(context, progress)
    );

  register('alEventLens.openPanel',       () => openPanel(context, store));
  register('alEventLens.refresh',         () => {
    indexWithProgress()
      .then((idx) => store.set(idx))
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
  register('alEventLens.gotoSubscriber',  (...args) => {
    if (!args[0]) { return; }
    // Args may arrive as a real vscode.Location (from CodeLens / Tree) or as
    // a plain {uri, range} bag (structured-cloned from a webview message).
    // Reconstruct both pieces so showTextDocument gets canonical instances.
    const loc = args[0] as { uri: vscode.Uri; range: vscode.Range };
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
    const range = new vscode.Range(
      loc.range.start.line, loc.range.start.character,
      loc.range.end.line,   loc.range.end.character
    );
    void vscode.window.showTextDocument(uri, { selection: range });
  });
  register('alEventLens.exportMermaid',   (...args) => {
    const publisher = (args[0] as Publisher | undefined) ?? getSelectedPublisher();
    void runExportMermaid(publisher, store);
  });

  context.subscriptions.push(registerTreeView(store));
  context.subscriptions.push(registerCodeLens(context, store));
  context.subscriptions.push(registerSaveWatcher(context, store));

  // Fire-and-forget initial index. The result populates the store so the
  // panel, tree, and CodeLens surfaces can render once it completes.
  indexWithProgress()
    .then((idx) => {
      store.set(idx);
      console.log(`AL EventLens: indexed ${idx.publishers.length} publishers, ${idx.subscribers.length} subscribers`);
    })
    .catch((err) => console.error('AL EventLens: indexing failed', err));
}

export function deactivate(): void {
  // nothing to clean up; all disposables are in context.subscriptions
}

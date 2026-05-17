import * as vscode from 'vscode';
import { getSelectedPublisher, openPanel, postSelectToPanel } from './ui/panel';
import { registerTreeView } from './ui/treeView';
import { registerCodeLens } from './ui/codelens';
import { renderMermaid } from './ui/mermaid';
import { findSubscribersFor } from './index/match';
import { registerSaveWatcher } from './index/watcher';
import { buildIndex } from './index/indexer';
import { EventIndexStore } from './index/store';
import type { Publisher } from './al/types';

export function activate(context: vscode.ExtensionContext): void {
  const store = new EventIndexStore();
  context.subscriptions.push(store);

  const register = (command: string, handler: (...args: unknown[]) => unknown): void => {
    context.subscriptions.push(vscode.commands.registerCommand(command, handler));
  };

  register('alEventLens.openPanel',       () => openPanel(context, store));
  register('alEventLens.refresh',         () => {
    buildIndex(context)
      .then((idx) => store.set(idx))
      .catch((err) => console.error('AL EventLens: refresh failed', err));
  });
  register('alEventLens.revealPublisher', (...args) => {
    if (!args[0]) { return; }
    const publisher = args[0] as Publisher;
    openPanel(context, store);
    postSelectToPanel(publisher);
  });
  register('alEventLens.gotoSubscriber',  (...args) => {
    if (!args[0]) { return; }
    // Args may arrive as a real vscode.Location (from CodeLens / Tree) or as
    // a plain {uri, range} bag (structured-cloned from a webview message).
    // Reconstruct both pieces so showTextDocument gets canonical instances.
    const loc = args[0] as { uri: vscode.Uri; range: vscode.Range };
    const uri = vscode.Uri.from(loc.uri);
    const range = new vscode.Range(
      loc.range.start.line, loc.range.start.character,
      loc.range.end.line,   loc.range.end.character
    );
    void vscode.window.showTextDocument(uri, { selection: range });
  });
  register('alEventLens.exportMermaid',   (...args) => {
    const publisher = (args[0] as Publisher | undefined) ?? getSelectedPublisher();
    if (!publisher) {
      void vscode.window.showWarningMessage(
        'AL EventLens: open the panel and select a publisher to export.'
      );
      return;
    }
    const matches = findSubscribersFor(publisher, store.get().subscribers);
    const mermaid = renderMermaid(publisher, matches);
    void vscode.env.clipboard.writeText(mermaid).then(() => {
      void vscode.window.showInformationMessage(
        `AL EventLens: copied ${matches.length} subscriber${matches.length === 1 ? '' : 's'} to clipboard as Mermaid.`
      );
    });
  });

  context.subscriptions.push(registerTreeView(context, store));
  context.subscriptions.push(registerCodeLens(context, store));
  context.subscriptions.push(registerSaveWatcher(context, store));

  // Fire-and-forget initial index. The result populates the store so the
  // panel, tree, and CodeLens surfaces can render once it completes.
  buildIndex(context)
    .then((idx) => {
      store.set(idx);
      console.log(`AL EventLens: indexed ${idx.publishers.length} publishers, ${idx.subscribers.length} subscribers`);
    })
    .catch((err) => console.error('AL EventLens: indexing failed', err));
}

export function deactivate(): void {
  // nothing to clean up; all disposables are in context.subscriptions
}

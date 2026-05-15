import * as vscode from 'vscode';
import { openPanel } from './ui/panel';
import { registerTreeView } from './ui/treeView';
import { registerCodeLens } from './ui/codelens';
import { registerSaveWatcher } from './index/watcher';
import { buildIndex } from './index/indexer';

export function activate(context: vscode.ExtensionContext): void {
  const register = (command: string, handler: (...args: unknown[]) => unknown): void => {
    context.subscriptions.push(vscode.commands.registerCommand(command, handler));
  };

  register('alEventLens.openPanel',       () => openPanel(context));
  register('alEventLens.refresh',         () => { throw new Error('alEventLens.refresh: not yet implemented'); });
  register('alEventLens.revealPublisher', () => { throw new Error('alEventLens.revealPublisher: not yet implemented'); });
  register('alEventLens.gotoSubscriber',  () => { throw new Error('alEventLens.gotoSubscriber: not yet implemented'); });
  register('alEventLens.exportMermaid',   () => { throw new Error('alEventLens.exportMermaid: not yet implemented'); });

  context.subscriptions.push(registerTreeView(context));
  context.subscriptions.push(registerCodeLens(context));
  context.subscriptions.push(registerSaveWatcher(context));

  // Fire-and-forget initial index for verification. The result is logged
  // but not yet wired into the panel, tree, or CodeLens — those land with
  // their own issues.
  buildIndex(context)
    .then((idx) => console.log(`AL EventLens: indexed ${idx.publishers.length} publishers, ${idx.subscribers.length} subscribers`))
    .catch((err) => console.error('AL EventLens: indexing failed', err));
}

export function deactivate(): void {
  // nothing to clean up; all disposables are in context.subscriptions
}

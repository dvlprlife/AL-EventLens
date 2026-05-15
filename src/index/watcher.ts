import * as vscode from 'vscode';

/**
 * Register the on-save watcher that incrementally re-parses an AL file
 * after it is saved and updates the in-memory index. Returns a disposable
 * that the caller is expected to push into `context.subscriptions`.
 *
 * Gated by the `alEventLens.indexOnSave` setting — when disabled, the
 * watcher is a no-op.
 */
export function registerSaveWatcher(context: vscode.ExtensionContext): vscode.Disposable {
  throw new Error(`registerSaveWatcher(${context.extension.id}): not yet implemented`);
}

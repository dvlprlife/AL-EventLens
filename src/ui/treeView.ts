import * as vscode from 'vscode';

/**
 * Register the activity-bar TreeView (`alEventLensView`) listing
 * publishers grouped by source app. Returns the underlying TreeView so
 * the caller can wire reveal/refresh into the index lifecycle.
 */
export function registerTreeView(context: vscode.ExtensionContext): vscode.Disposable {
  throw new Error(`registerTreeView(${context.extension.id}): not yet implemented`);
}

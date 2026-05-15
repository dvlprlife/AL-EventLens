import * as vscode from 'vscode';

/**
 * Create or focus the AL EventLens webview panel — the searchable
 * publisher list plus subscriber detail view. The panel posts
 * `revealPublisher` / `gotoSubscriber` messages back to the extension
 * host when items are clicked.
 */
export function openPanel(context: vscode.ExtensionContext): void {
  throw new Error(`openPanel(${context.extension.id}): not yet implemented`);
}

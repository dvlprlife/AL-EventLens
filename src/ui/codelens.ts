import * as vscode from 'vscode';

/**
 * Register the CodeLens provider that draws a "N subscribers" lens above
 * each `[IntegrationEvent]` and `[BusinessEvent]` declaration. Clicking
 * the lens fires `alEventLens.revealPublisher` to open the panel scoped
 * to that publisher. Gated by `alEventLens.codeLens.enabled`.
 */
export function registerCodeLens(context: vscode.ExtensionContext): vscode.Disposable {
  throw new Error(`registerCodeLens(${context.extension.id}): not yet implemented`);
}

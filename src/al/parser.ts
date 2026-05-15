import type * as vscode from 'vscode';
import type { Publisher, Subscriber } from './types';

/**
 * Parse a single AL source file's text into the publishers and subscribers
 * it declares.
 *
 * Supports both pre-BC22 (`'Codeunit Name'`, `'OnEvent'` — string literals)
 * and BC22+ (`Codeunit::"Name"`, `OnEvent` — bare identifier) subscriber
 * syntaxes. Recognizes `[IntegrationEvent]` and `[BusinessEvent]` attribute
 * forms with any of their parameter shapes.
 */
export function parseAl(
  uri: vscode.Uri,
  text: string
): { publishers: Publisher[]; subscribers: Subscriber[] } {
  throw new Error(`parseAl(${uri.toString()}, ${text.length} bytes): not yet implemented`);
}

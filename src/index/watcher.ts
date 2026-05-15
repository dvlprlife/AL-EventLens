import * as vscode from 'vscode';
import { parseAl } from '../al/parser';
import { collectTriggerOwners, synthesizeTriggerPublishers } from '../al/triggers';
import type { ObjectRef, Publisher } from '../al/types';
import type { EventIndexStore } from './store';

/**
 * Register the on-save watcher that incrementally re-parses an AL file
 * after it is saved and updates the in-memory index. Returns a disposable
 * that the caller is expected to push into `context.subscriptions`.
 *
 * Gated by the `alEventLens.indexOnSave` setting — when disabled, the
 * watcher is still registered but the handler returns early so no parsing
 * or store mutation occurs. Trigger synthesis is gated independently by
 * `alEventLens.includeTriggerEvents`, matching the full-pass indexer.
 */
export function registerSaveWatcher(
  context: vscode.ExtensionContext,
  store: EventIndexStore
): vscode.Disposable {
  // Use `void` because onDidSaveTextDocument doesn't await the handler;
  // unhandled rejections would otherwise be silently swallowed.
  const sub = vscode.workspace.onDidSaveTextDocument((document) => {
    void handleSave(document, store);
  });
  // The context is unused at the moment but is kept in the signature so
  // the watcher can subscribe to additional workspace events (config
  // changes, file deletes) in later iterations without a breaking change.
  void context;
  return sub;
}

/**
 * Inner save handler — exported so tests can drive it directly without
 * stubbing `vscode.workspace.onDidSaveTextDocument`. Reads the same two
 * settings as `buildIndex` (`indexOnSave`, `includeTriggerEvents`) and
 * routes the parsed records through `store.updateFile`.
 */
export async function handleSave(
  document: vscode.TextDocument,
  store: EventIndexStore
): Promise<void> {
  if (document.languageId !== 'al') {
    return;
  }
  const cfg = vscode.workspace.getConfiguration('alEventLens');
  if (cfg.get<boolean>('indexOnSave', true) === false) {
    return;
  }

  const text = document.getText();
  const parsed = parseAl(document.uri, text);

  let triggers: Publisher[] = [];
  if (cfg.get<boolean>('includeTriggerEvents', true)) {
    const owners = new Map<string, ObjectRef>();
    collectTriggerOwners(text, owners);
    for (const owner of owners.values()) {
      // Tag every synthesized trigger publisher with the saved file's URI
      // so a subsequent save of the same file can replace (not duplicate)
      // them in the store.
      triggers.push(
        ...synthesizeTriggerPublishers(owner).map((p) => ({
          ...p,
          sourceUri: document.uri
        }))
      );
    }
  }

  store.updateFile(document.uri, [...parsed.publishers, ...triggers], parsed.subscribers);
}

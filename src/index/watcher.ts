import * as vscode from 'vscode';
import { parseAl } from '../al/parser';
import { collectTriggerOwners, synthesizeTriggerPublishers } from '../al/triggers';
import type { ObjectRef, Publisher } from '../al/types';
import { attributeToApp, discoverWorkspaceApps } from './appJson';
import { bumpStartedGeneration } from './reindex';
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
 * Per-URI token reservation for `handleSave`. Two rapid saves of the SAME
 * file would otherwise race across the `discoverWorkspaceApps` await:
 * whichever handler resolves LAST would write its (possibly older) text
 * into the store. We mint a unique `Symbol()` per save and bail before
 * the `store.updateFile` commit if a newer save for the same URI has
 * overtaken us. Keyed by `uri.toString()` so saves to DIFFERENT files
 * race independently — there is no cross-URI coalescing.
 *
 * `Symbol()` is used instead of an integer counter because the cleanup
 * step deletes the Map entry once the winning save commits: a
 * subsequent integer-based reservation would restart at 1 and could
 * collide with an earlier mid-flight handler whose `myGen` was also 1,
 * silently letting stale text overwrite the new save. Each `Symbol()`
 * is unique, so an overtaken handler's token can never accidentally
 * match a later reservation after a delete-reset.
 */
const latestSaveGeneration = new Map<string, symbol>();

/**
 * Reset this module's per-URI generation state. Called from
 * `deactivate()` so a subsequent `activate()` (Developer: Reload Window
 * keeps the JS module alive) starts from an empty Map rather than
 * inheriting tokens from the previous activation's in-flight saves —
 * those handlers' promises were discarded with the old `context` but
 * the Map entries (and the side effects of a later cleanup) outlive them.
 *
 * Production code other than `deactivate()` MUST NOT call this.
 */
export function resetWatcherStateForReload(): void {
  latestSaveGeneration.clear();
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

  // Reserve a fresh per-URI token BEFORE the synchronous `getText` so the
  // captured-text-then-await-then-commit window is fully covered: if a
  // newer save lands while we're awaiting `discoverWorkspaceApps`, it
  // will overwrite this entry with its own Symbol and our pre-commit
  // check will drop our commit.
  const key = document.uri.toString();
  const myToken = Symbol();
  latestSaveGeneration.set(key, myToken);

  // Wrap the entire post-reservation body in try/finally so cleanup runs
  // on BOTH the success path and any parse/updateFile throw — otherwise
  // a `parseAl` (or `collectTriggerOwners`, or `store.updateFile`) bug
  // would leak the Map entry forever. The cleanup is gated by token
  // identity so a newer save's reservation is not deleted.
  try {
    const text = document.getText();
    // Attribute the saved file to its workspace AL project so the re-parsed
    // records keep the same `owner.appId` the full index assigned them — a
    // multi-root project's saved file must not bounce into the `(workspace)`
    // bucket. `store.updateFile` matches surviving records by URI, which is
    // `appId`-independent, so the resolved `appId` simply rides along.
    const workspaceApps = await discoverWorkspaceApps();
    // Early bail before parseAl: if a newer save has already overtaken us
    // we'd just throw away the parse result at the pre-commit check below,
    // and parseAl + collectTriggerOwners can run ~200ms on a large file.
    // On rapid double-saves this skips that wasted work for every losing
    // handler. The pre-commit guard further down stays as belt-and-
    // suspenders for races that resolve between here and the commit.
    if (latestSaveGeneration.get(key) !== myToken) {
      return;
    }
    const appId = attributeToApp(document.uri, workspaceApps);
    const parsed = parseAl(document.uri, text, appId);

    let triggers: Publisher[] = [];
    if (cfg.get<boolean>('includeTriggerEvents', true)) {
      const owners = new Map<string, ObjectRef>();
      collectTriggerOwners(text, owners, appId);
      for (const owner of owners.values()) {
        // synthesizeTriggerPublishers tags each result with sourceUri so
        // a subsequent save of the same file can replace (not duplicate)
        // them in the store.
        triggers.push(...synthesizeTriggerPublishers(owner, document.uri));
      }
    }

    // Generation guard: a newer save for the same URI has overtaken us
    // while we were awaiting. Drop our (now-stale) commit silently so the
    // winner's text is what lands in the store.
    if (latestSaveGeneration.get(key) !== myToken) {
      return;
    }
    store.updateFile(document.uri, [...parsed.publishers, ...triggers], parsed.subscribers);
    // Invalidate any in-flight `runIndexAndCommit` whose captured generation
    // token is older than the bumped counter. Without this, a buildIndex
    // started BEFORE the save can resolve AFTER and overwrite the saved-
    // file delta with its pre-save snapshot (the save's incremental update
    // and the buildIndex's full-replace `store.set` are independently
    // generation-gated, so the rebuild's commit isn't blocked by the save
    // alone). The bumped value is discarded; we only want the side effect.
    bumpStartedGeneration();
  } finally {
    // Bounded-Map cleanup: only delete the entry when WE are still the
    // most-recent reservation for this URI. If a newer save overwrote
    // our slot with its own Symbol while we awaited, leave its entry in
    // place so its own commit-time check still sees the right token.
    // Net effect: the Map only holds in-flight save tokens, not historical
    // ones, so it can't grow unbounded over a long session of saves to
    // many distinct URIs. Runs from `finally` so the cleanup is reached
    // on BOTH success and throw paths — a parser bug on one file no
    // longer leaks a Map entry for its URI.
    if (latestSaveGeneration.get(key) === myToken) {
      latestSaveGeneration.delete(key);
    }
  }
}

/**
 * Test-only accessor for the per-URI generation Map's current size.
 * Used by the bounded-Map regression test to assert entries are cleared
 * after a quiescent save. Not part of the production API surface.
 */
export function __getSaveGenerationMapSize(): number {
  return latestSaveGeneration.size;
}

/**
 * Test-only accessor: whether the Map currently holds an entry for the
 * given URI key. Used by the parse-throw regression test to assert
 * cleanup runs on the error path even when no caller can observe
 * `handleSave`'s rejection (the production wire `void handleSave(...)`
 * discards it).
 */
export function __hasSaveGenerationEntry(key: string): boolean {
  return latestSaveGeneration.has(key);
}

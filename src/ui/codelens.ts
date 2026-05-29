import * as vscode from 'vscode';
import { parseAl } from '../al/parser';
import { countSubscribersByPublisherKey, publisherKey } from '../index/match';
import type { EventIndexStore } from '../index/store';

/**
 * `vscode.CodeLensProvider` for the `al` language. For each
 * `[IntegrationEvent]` / `[BusinessEvent]` declaration in the active
 * document, draws a single `"N subscribers"` lens above the procedure
 * name pointing at the `alEventLens.revealPublisher` command.
 *
 * Trigger publishers (`kind: 'trigger'`) carry no source location and
 * are skipped — they have nothing to draw above.
 *
 * The lens title is computed eagerly in `provideCodeLenses`, so there is
 * intentionally no `resolveCodeLens` override. The workspace-wide
 * publisher-key → subscriber-count map is cached per store generation
 * (see `counts()` / `fireChange()`) so VS Code's per-edit, per-scroll
 * `provideCodeLenses` calls do not rebuild it each time.
 */
export class AlEventLensCodeLensProvider implements vscode.CodeLensProvider {
  private readonly _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
  public readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;
  /** Cached publisher-key → subscriber-count map for the current store state.
   *  Invalidated in `fireChange()`; recomputed lazily on first access per cycle. */
  private _counts?: ReadonlyMap<string, number>;

  constructor(private readonly store: EventIndexStore) {}

  /** Trigger a re-fetch from VS Code; called when the store changes or
   *  the gating setting toggles. */
  public fireChange(): void {
    this._counts = undefined;
    this._onDidChangeCodeLenses.fire();
  }

  /** Lazily compute the workspace-wide publisher-key → subscriber-count map
   *  for the current store generation, reused across `provideCodeLenses`
   *  calls until `fireChange()` invalidates it. */
  private counts(): ReadonlyMap<string, number> {
    if (!this._counts) {
      this._counts = countSubscribersByPublisherKey(this.store.get().subscribers);
    }
    return this._counts;
  }

  public provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    // Read the setting fresh on every call so users can toggle without
    // a window reload.
    const enabled = vscode.workspace
      .getConfiguration('alEventLens')
      .get<boolean>('codeLens.enabled', true);
    if (!enabled) {
      return [];
    }

    // `parseAl` arg order is `(uri, text)` — do not swap.
    const parsed = parseAl(document.uri, document.getText());
    if (parsed.publishers.length === 0) {
      return [];
    }

    const counts = this.counts();

    const lenses: vscode.CodeLens[] = [];
    for (const p of parsed.publishers) {
      // Trigger publishers have `kind === 'trigger'` and no `location`.
      // The kind check is the contract; the `location` guard is defensive.
      if (p.kind !== 'integration' && p.kind !== 'business') {
        continue;
      }
      if (!p.location) {
        continue;
      }
      const count = counts.get(publisherKey(p)) ?? 0;
      const title = `${count} ${count === 1 ? 'subscriber' : 'subscribers'}`;
      lenses.push(
        new vscode.CodeLens(p.location.range, {
          command: 'alEventLens.revealPublisher',
          title,
          arguments: [p]
        })
      );
    }
    return lenses;
  }

  public dispose(): void {
    this._onDidChangeCodeLenses.dispose();
  }
}

/**
 * Register the CodeLens provider that draws a "N subscribers" lens above
 * each `[IntegrationEvent]` and `[BusinessEvent]` declaration. Clicking
 * the lens fires `alEventLens.revealPublisher` to open the panel scoped
 * to that publisher. Gated by `alEventLens.codeLens.enabled`.
 *
 * The returned disposable owns the provider registration, the
 * `store.onDidChange` subscription, the configuration-change
 * subscription, and the provider's `EventEmitter`, so a single
 * `context.subscriptions.push(...)` cleans everything up on shutdown.
 */
export function registerCodeLens(
  context: vscode.ExtensionContext,
  store: EventIndexStore
): vscode.Disposable {
  void context;
  const provider = new AlEventLensCodeLensProvider(store);
  const registration = vscode.languages.registerCodeLensProvider(
    { language: 'al' },
    provider
  );

  // Subscriber counts may have changed — invalidate so VS Code re-calls
  // `provideCodeLenses`. Both a full re-index and an incremental save count.
  const storeSub = store.onDidChange(() => provider.fireChange());
  const fileSub = store.onDidUpdateFile(() => provider.fireChange());

  // Setting toggle takes effect without a window reload.
  const cfgSub = vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration('alEventLens.codeLens.enabled')) {
      provider.fireChange();
    }
  });

  return vscode.Disposable.from(registration, storeSub, fileSub, cfgSub, provider);
}

import * as vscode from 'vscode';
import { parseAl } from '../al/parser';
import type { ObjectKind, Subscriber } from '../al/types';
import type { EventIndexStore } from '../index/store';

/** Mirror of `resolver.ts`'s key — case-insensitive on name and event.
 *  Kept local to this file (matching the same pattern in `treeView.ts`) so
 *  CodeLens has zero coupling to the freshly-merged tree code. If the
 *  matching logic ever changes, both copies must move together; folding
 *  them into a shared helper in `resolver.ts` is a future cleanup. */
function matchKey(kind: ObjectKind, name: string, event: string): string {
  return `${kind} ${name.toLowerCase()} ${event.toLowerCase()}`;
}

/** Build a `Map<key, count>` keyed identically to `resolver.ts`. */
function countSubscribersByPublisherKey(
  subscribers: ReadonlyArray<Subscriber>
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const s of subscribers) {
    const k = matchKey(s.target.kind, s.target.name, s.targetEvent);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return counts;
}

/**
 * `vscode.CodeLensProvider` for the `al` language. For each
 * `[IntegrationEvent]` / `[BusinessEvent]` declaration in the active
 * document, draws a single `"N subscribers"` lens above the procedure
 * name pointing at the `alEventLens.revealPublisher` command.
 *
 * Trigger publishers (`kind: 'trigger'`) carry no source location and
 * are skipped — they have nothing to draw above.
 *
 * The lens title is computed eagerly in `provideCodeLenses` (counts are
 * cheap), so there is intentionally no `resolveCodeLens` override.
 */
export class AlEventLensCodeLensProvider implements vscode.CodeLensProvider {
  private readonly _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
  public readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;

  constructor(private readonly store: EventIndexStore) {}

  /** Trigger a re-fetch from VS Code; called when the store changes or
   *  the gating setting toggles. */
  public fireChange(): void {
    this._onDidChangeCodeLenses.fire();
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

    const counts = countSubscribersByPublisherKey(this.store.get().subscribers);

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
      const count = counts.get(matchKey(p.owner.kind, p.owner.name, p.eventName)) ?? 0;
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
  // `provideCodeLenses`.
  const storeSub = store.onDidChange(() => provider.fireChange());

  // Setting toggle takes effect without a window reload.
  const cfgSub = vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration('alEventLens.codeLens.enabled')) {
      provider.fireChange();
    }
  });

  return vscode.Disposable.from(registration, storeSub, cfgSub, provider);
}

import * as vscode from 'vscode';
import { handlerUsageKey, indexHandlerUsages, parseHandlersFrom } from '../al/handlers';
import type { AlObjectContext } from '../al/parser';
import { makeObjectContext, parseAlFrom } from '../al/parser';
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
    // Read the settings fresh on every call so users can toggle without
    // a window reload.
    const cfg = vscode.workspace.getConfiguration('alEventLens');
    const wantEvents = cfg.get<boolean>('codeLens.enabled', true);
    const wantHandlers = cfg.get<boolean>('handlerCodeLens.enabled', true);
    // Short-circuit before touching the document: with both lens kinds off
    // there is nothing to draw, and VS Code still calls this on every edit
    // and scroll of every open `al` editor.
    if (!wantEvents && !wantHandlers) {
      return [];
    }

    // One context for both sweeps: `makeObjectContext` runs `stripComments`
    // and `findObjects` over the whole document, so building it per parser
    // entry point would scan the file twice on every refresh.
    const ctx = makeObjectContext(document.getText());
    if (!ctx) {
      return [];
    }

    return [
      ...(wantEvents ? this.eventLenses(document.uri, ctx) : []),
      ...(wantHandlers ? handlerLenses(document.uri, ctx) : [])
    ];
  }

  /** `"N subscribers"` above each `[IntegrationEvent]` / `[BusinessEvent]`. */
  private eventLenses(uri: vscode.Uri, ctx: AlObjectContext): vscode.CodeLens[] {
    const parsed = parseAlFrom(uri, ctx);
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
 * `"N test usages"` / `"unused handler"` above each handler method
 * (`[MessageHandler]`, `[ConfirmHandler]`, `[PageHandler]`, …).
 *
 * Unlike the event lenses this needs no store lookup: AL resolves handler
 * references within a single test codeunit, so every reference that can
 * possibly count is in the document being parsed. That also means the lens
 * is correct the instant a file is opened, with no dependency on indexing
 * having finished.
 *
 * A handler with usages is clickable and opens VS Code's native references
 * peek at the referencing test methods. A handler with none is dead test
 * code — the AL compiler flags a `[HandlerFunctions]` entry naming a handler
 * that doesn't exist, but never the reverse — so it is rendered as plain,
 * non-clickable text (a `CodeLens` whose command is the empty string).
 */
function handlerLenses(uri: vscode.Uri, ctx: AlObjectContext): vscode.CodeLens[] {
  const { declarations, references } = parseHandlersFrom(uri, ctx);
  if (declarations.length === 0) {
    return [];
  }

  const usages = indexHandlerUsages(references);

  return declarations.map((d) => {
    const used = usages.get(handlerUsageKey(d.owner, d.name)) ?? [];
    if (used.length === 0) {
      return new vscode.CodeLens(d.location.range, {
        command: '',
        title: 'unused handler'
      });
    }
    return new vscode.CodeLens(d.location.range, {
      command: 'alEventLens.showHandlerUsages',
      title: `${used.length} test ${used.length === 1 ? 'usage' : 'usages'}`,
      arguments: [d.location, used.map((r) => r.location)]
    });
  });
}

/**
 * Register the CodeLens provider that draws a "N subscribers" lens above
 * each `[IntegrationEvent]` and `[BusinessEvent]` declaration, and a
 * "N test usages" / "unused handler" lens above each test handler method.
 * Clicking a publisher lens fires `alEventLens.revealPublisher` to open the
 * panel scoped to that publisher; clicking a handler lens fires
 * `alEventLens.showHandlerUsages` to peek its referencing test methods.
 * Gated by `alEventLens.codeLens.enabled` and
 * `alEventLens.handlerCodeLens.enabled` respectively.
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
    if (
      e.affectsConfiguration('alEventLens.codeLens.enabled') ||
      e.affectsConfiguration('alEventLens.handlerCodeLens.enabled')
    ) {
      provider.fireChange();
    }
  });

  return vscode.Disposable.from(registration, storeSub, fileSub, cfgSub, provider);
}

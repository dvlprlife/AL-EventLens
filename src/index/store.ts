import * as vscode from 'vscode';
import type { Publisher, Subscriber } from '../al/types';
import type { EventIndex } from './indexer';
import { resolveSubscribers } from './resolver';

/**
 * Long-lived, in-memory event index that downstream UI surfaces (panel,
 * tree view, CodeLens, status badges) subscribe to via `onDidChange`. The
 * full-pass indexer (`buildIndex`) seeds the store on activation; the save
 * watcher mutates it incrementally on every `.al` save via `updateFile`.
 *
 * This is the first long-lived `vscode.EventEmitter`/`Disposable` consumer
 * in `src/index/`. The vscode surface here is intentionally minimal —
 * `EventEmitter` and `Disposable` only — so the orchestration layer stays
 * test-friendly.
 */
export class EventIndexStore implements vscode.Disposable {
  private current: EventIndex = { publishers: [], subscribers: [] };
  private readonly _onDidChange = new vscode.EventEmitter<EventIndex>();

  /** Fires whenever `set` or `updateFile` mutates the index. */
  public readonly onDidChange = this._onDidChange.event;

  /** Snapshot accessor — UI surfaces should treat the result as immutable. */
  public get(): EventIndex {
    return this.current;
  }

  /**
   * Replace the entire index in one shot. Used by the initial full pass
   * (`buildIndex` result) on activation and by manual refresh commands.
   */
  public set(index: EventIndex): void {
    this.current = index;
    this._onDidChange.fire(index);
  }

  /**
   * Replace every publisher/subscriber attributed to `uri` with the
   * supplied lists, then re-run `resolveSubscribers` so cross-file links
   * stay correct. Trigger publishers are matched on `sourceUri` (they
   * carry no `location`); everything else is matched on `location.uri`.
   */
  public updateFile(
    uri: vscode.Uri,
    publishers: ReadonlyArray<Publisher>,
    subscribers: ReadonlyArray<Subscriber>
  ): void {
    const uriKey = uri.toString();

    const survivingPublishers = this.current.publishers.filter((p) => {
      const key = p.location?.uri.toString() ?? p.sourceUri?.toString();
      return key !== uriKey;
    });
    const survivingSubscribers = this.current.subscribers.filter(
      (s) => s.location.uri.toString() !== uriKey
    );

    const mergedPublishers = [...survivingPublishers, ...publishers];
    const mergedSubscribers = [...survivingSubscribers, ...subscribers];
    const resolved = resolveSubscribers(mergedPublishers, mergedSubscribers);

    this.current = { publishers: mergedPublishers, subscribers: resolved };
    this._onDidChange.fire(this.current);
  }

  public dispose(): void {
    this._onDidChange.dispose();
  }
}

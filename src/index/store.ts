import * as vscode from 'vscode';
import type { Publisher, Subscriber } from '../al/types';
import type { EventIndex } from './indexer';
import { resolveSubscribers } from './resolver';

/**
 * The delta carried by `EventIndexStore.onDidUpdateFile` when a single
 * `.al` file is re-indexed: the saved file's own publishers, plus the
 * **full** re-resolved subscriber list — a publisher added or removed in
 * the saved file can flip `resolved` on subscribers in other files, so
 * the whole subscriber array is carried, not just the saved file's.
 */
export interface FileUpdate {
  readonly uri: vscode.Uri;
  readonly publishers: ReadonlyArray<Publisher>;
  readonly subscribers: ReadonlyArray<Subscriber>;
}

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
  private current: EventIndex = { publishers: [], subscribers: [], appMeta: new Map() };
  private _isInitialized = false;
  private readonly _onDidChange = new vscode.EventEmitter<EventIndex>();
  private readonly _onDidUpdateFile = new vscode.EventEmitter<FileUpdate>();

  /** Fires on a full-index replace — `set()` (initial pass, manual refresh). */
  public readonly onDidChange = this._onDidChange.event;
  /** Fires on an incremental single-file re-index — `updateFile()`. */
  public readonly onDidUpdateFile = this._onDidUpdateFile.event;

  /** Snapshot accessor — UI surfaces should treat the result as immutable. */
  public get(): EventIndex {
    return this.current;
  }

  /**
   * Whether the initial full-pass index has resolved at least once (success
   * OR failure). UI surfaces use this to distinguish "indexing hasn't
   * finished yet" — show a spinner placeholder — from "indexed and empty"
   * — show the actual empty-state message. Flips to `true` on the first
   * `set` or `updateFile`; never flips back.
   */
  public get isInitialized(): boolean {
    return this._isInitialized;
  }

  /**
   * Replace the entire index in one shot. Used by the initial full pass
   * (`buildIndex` result) on activation and by manual refresh commands.
   */
  public set(index: EventIndex): void {
    this.current = index;
    this._isInitialized = true;
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

    // updateFile only touches workspace AL files (which carry no appMeta) —
    // the dependency-app friendly names pass through unchanged.
    this.current = {
      publishers: mergedPublishers,
      subscribers: resolved,
      appMeta: this.current.appMeta
    };
    this._isInitialized = true;
    // Incremental signal: the saved file's publishers plus the full
    // re-resolved subscriber list. `onDidChange` (full replace) is NOT
    // fired — consumers that need to react to a save subscribe to both.
    this._onDidUpdateFile.fire({ uri, publishers, subscribers: resolved });
  }

  public dispose(): void {
    this._onDidChange.dispose();
    this._onDidUpdateFile.dispose();
  }
}

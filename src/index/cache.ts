import type * as vscode from 'vscode';
import type { Publisher } from '../al/types';

/** Cache key for a single `.app` package. */
export interface CacheKey {
  readonly appId: string;
  readonly version: string;
  /** Modification time of the `.app` file, in milliseconds since the epoch. */
  readonly mtime: number;
}

/**
 * Load a cached publisher list for the given key, or return undefined if
 * the cache is cold or stale. Storage lives under
 * `extensionContext.globalStorageUri`.
 */
export async function loadCachedSymbols(
  context: vscode.ExtensionContext,
  key: CacheKey
): Promise<Publisher[] | undefined> {
  throw new Error(`loadCachedSymbols(${context.extension.id}, appId=${key.appId}@${key.version}): not yet implemented`);
}

/**
 * Persist a parsed publisher list under the given key. Subsequent
 * `loadCachedSymbols` calls with the same `(appId, version, mtime)`
 * triple will return the stored value.
 */
export async function storeCachedSymbols(
  context: vscode.ExtensionContext,
  key: CacheKey,
  publishers: ReadonlyArray<Publisher>
): Promise<void> {
  throw new Error(`storeCachedSymbols(${context.extension.id}, appId=${key.appId}@${key.version}, ${publishers.length} publishers): not yet implemented`);
}

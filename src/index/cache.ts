import * as vscode from 'vscode';
import type { Publisher } from '../al/types';

/** Cache key for a single `.app` package. */
export interface CacheKey {
  readonly appId: string;
  readonly version: string;
  /** Modification time of the `.app` file, in milliseconds since the epoch. */
  readonly mtime: number;
}

/** What `loadCachedSymbols` returns on a hit — the publisher list plus the
 *  friendly-name metadata that was persisted alongside it. */
export interface CachedAppData {
  readonly publishers: Publisher[];
  readonly name?: string;
  readonly appPublisher?: string;
}

const SYMBOLS_DIR = 'symbols';

/** Bump whenever the on-disk shape changes. v2 added `name` / `appPublisher`
 *  alongside the previously-bare publisher array. v3 added per-publisher
 *  `parameters` (procedure signature) so the panel can render them without a
 *  re-parse. v4 has the same on-disk shape as v3 but invalidates entries
 *  written by the broken symbol-reference dispatcher that silently dropped
 *  publishers inside `Namespaces[]` (everything under a namespace in BC 24+
 *  packages — i.e. almost all of BaseApp). Older entries are silently
 *  treated as cache misses. */
const SCHEMA_VERSION = 4;

interface CachedPayloadV4 {
  readonly schemaVersion: 4;
  readonly publishers: Publisher[];
  readonly name?: string;
  readonly appPublisher?: string;
}

/**
 * Sanitize a path segment so it round-trips safely on every platform's
 * filesystem. `appId` and `version` come from a `.app` package's manifest
 * and are usually ASCII-safe, but we never trust upstream data — anything
 * outside `[A-Za-z0-9._-]` collapses to `_`.
 */
function safe(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]/g, '_');
}

function cacheFileUri(context: vscode.ExtensionContext, key: CacheKey): vscode.Uri {
  return vscode.Uri.joinPath(
    context.globalStorageUri,
    SYMBOLS_DIR,
    `${safe(key.appId)}__${safe(key.version)}__${key.mtime}.json`
  );
}

function symbolsDirUri(context: vscode.ExtensionContext): vscode.Uri {
  return vscode.Uri.joinPath(context.globalStorageUri, SYMBOLS_DIR);
}

function isCacheEnabled(): boolean {
  return vscode.workspace.getConfiguration('alEventLens').get<boolean>('cache.enabled', true);
}

/**
 * Load a cached publisher list (plus friendly-name metadata) for the
 * given key, or return undefined if the cache is cold or stale. Storage
 * lives under `extensionContext.globalStorageUri`.
 *
 * Returns `undefined` (never throws) for any of: caching disabled, file
 * missing, file unreadable, JSON malformed, payload shape unexpected, or
 * `schemaVersion` mismatch. The indexer treats `undefined` as a cache
 * miss and re-parses the package.
 */
export async function loadCachedSymbols(
  context: vscode.ExtensionContext,
  key: CacheKey
): Promise<CachedAppData | undefined> {
  if (!isCacheEnabled()) {
    return undefined;
  }
  let bytes: Uint8Array;
  try {
    bytes = await vscode.workspace.fs.readFile(cacheFileUri(context, key));
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return undefined;
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    (parsed as { schemaVersion?: unknown }).schemaVersion !== SCHEMA_VERSION ||
    !Array.isArray((parsed as { publishers?: unknown }).publishers)
  ) {
    return undefined;
  }
  const payload = parsed as CachedPayloadV4;
  // Cached records intentionally have no `vscode.Location` — see
  // storeCachedSymbols. Cast is safe because every consumer treats
  // `Publisher.location` as optional.
  return {
    publishers: payload.publishers,
    name: payload.name,
    appPublisher: payload.appPublisher
  };
}

/**
 * Persist a parsed publisher list (and the app's friendly-name metadata)
 * under the given key. Subsequent `loadCachedSymbols` calls with the same
 * `(appId, version, mtime)` triple will return the stored value.
 *
 * Strips `vscode.Location` before serializing — `.app` publishers never
 * carry one and the type isn't JSON-safe. Also cleans up any older cache
 * entries for the same `appId` so a version bump doesn't leave stale
 * files behind.
 */
export async function storeCachedSymbols(
  context: vscode.ExtensionContext,
  key: CacheKey,
  publishers: ReadonlyArray<Publisher>,
  meta?: { name?: string; appPublisher?: string }
): Promise<void> {
  if (!isCacheEnabled()) {
    return;
  }
  const dir = symbolsDirUri(context);
  // createDirectory is recursive and idempotent in vscode.workspace.fs —
  // succeeds whether or not the directory already exists.
  await vscode.workspace.fs.createDirectory(dir);

  const target = cacheFileUri(context, key);
  const targetName = target.path.slice(target.path.lastIndexOf('/') + 1);
  const appPrefix = `${safe(key.appId)}__`;

  // Best-effort cleanup of older entries for the same appId. The
  // directory was just created above; any failure here is purely
  // defensive and must not block the write.
  try {
    const entries = await vscode.workspace.fs.readDirectory(dir);
    for (const [name, fileType] of entries) {
      if (fileType !== vscode.FileType.File) {
        continue;
      }
      if (!name.startsWith(appPrefix) || !name.endsWith('.json')) {
        continue;
      }
      if (name === targetName) {
        continue;
      }
      try {
        await vscode.workspace.fs.delete(vscode.Uri.joinPath(dir, name));
      } catch {
        // Skip any single file we can't delete; cleanup is best-effort.
      }
    }
  } catch {
    // readDirectory failed for a reason other than missing-dir; skip cleanup.
  }

  const strippedPublishers = publishers.map(({ owner, eventName, kind, parameters }) => ({
    owner,
    eventName,
    kind,
    ...(parameters !== undefined ? { parameters } : {})
  }));
  const payload: CachedPayloadV4 = {
    schemaVersion: SCHEMA_VERSION,
    publishers: strippedPublishers as Publisher[],
    name: meta?.name,
    appPublisher: meta?.appPublisher
  };
  await vscode.workspace.fs.writeFile(
    target,
    new TextEncoder().encode(JSON.stringify(payload))
  );
}

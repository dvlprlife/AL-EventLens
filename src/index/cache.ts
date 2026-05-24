import * as vscode from 'vscode';
import type { ObjectRef, Publisher, Subscriber } from '../al/types';

/** Cache key for a single `.app` package. */
export interface CacheKey {
  readonly appId: string;
  readonly version: string;
  /** Modification time of the `.app` file, in milliseconds since the epoch. */
  readonly mtime: number;
}

/** What `loadCachedSymbols` returns on a hit — the publisher list, the
 *  bundled-source subscribers and trigger owners, plus the friendly-name
 *  metadata, all persisted alongside each other. */
export interface CachedAppData {
  readonly publishers: Publisher[];
  readonly subscribers: Subscriber[];
  readonly triggerOwners: ObjectRef[];
  readonly name?: string;
  readonly appPublisher?: string;
}

const SYMBOLS_DIR = 'symbols';

/** Bump whenever the on-disk shape changes. v2 added `name` / `appPublisher`
 *  alongside the previously-bare publisher array. v3 added per-publisher
 *  `parameters` (procedure signature). v4 invalidated entries poisoned by the
 *  namespace-walk bug that silently dropped publishers inside `Namespaces[]`.
 *  v5 adds the bundled-source `subscribers` and `triggerOwners` so a cache
 *  hit can reuse them and skip re-decompressing the `.app`. Older entries
 *  are silently treated as cache misses. */
const SCHEMA_VERSION = 5;

/** A subscriber as persisted on disk. `vscode.Location` is not JSON-safe, so
 *  it is flattened to a URI string plus the start line/character; it revives
 *  to a `vscode.Location` on load. */
interface CachedSubscriber {
  readonly owner: ObjectRef;
  readonly target: ObjectRef;
  readonly targetEvent: string;
  readonly loc: { readonly uri: string; readonly line: number; readonly char: number };
}

interface CachedPayloadV5 {
  readonly schemaVersion: 5;
  readonly publishers: Publisher[];
  readonly subscribers: CachedSubscriber[];
  readonly triggerOwners: ObjectRef[];
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
 * Load cached symbols (publishers, bundled-source subscribers and trigger
 * owners, plus friendly-name metadata) for the given key, or return
 * undefined if the cache is cold or stale. Storage lives under
 * `extensionContext.globalStorageUri`.
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
    !Array.isArray((parsed as { publishers?: unknown }).publishers) ||
    !Array.isArray((parsed as { subscribers?: unknown }).subscribers) ||
    !Array.isArray((parsed as { triggerOwners?: unknown }).triggerOwners)
  ) {
    return undefined;
  }
  const payload = parsed as CachedPayloadV5;
  // Cached publishers intentionally have no `vscode.Location` — see
  // storeCachedSymbols. Cached subscribers revive their flattened `loc`
  // back to a `vscode.Location`; `resolved` is recomputed globally by
  // `resolveSubscribers` after the index is assembled, so the cached
  // value is intentionally not persisted (stored as `false`).
  const subscribers: Subscriber[] = payload.subscribers.map((s) => ({
    owner: s.owner,
    target: s.target,
    targetEvent: s.targetEvent,
    location: new vscode.Location(
      vscode.Uri.parse(s.loc.uri),
      new vscode.Position(s.loc.line, s.loc.char)
    ),
    resolved: false
  }));
  return {
    publishers: payload.publishers,
    subscribers,
    triggerOwners: payload.triggerOwners,
    name: payload.name,
    appPublisher: payload.appPublisher
  };
}

/**
 * Persist a parsed package's symbols under the given key: its publishers,
 * the subscribers and trigger owners discovered in its bundled `src/**`,
 * and the app's friendly-name metadata. Subsequent `loadCachedSymbols`
 * calls with the same `(appId, version, mtime)` triple return the stored
 * value, letting the indexer skip re-reading the `.app` entirely.
 *
 * Strips `vscode.Location` from publishers before serializing — `.app`
 * publishers never carry one and the type isn't JSON-safe; subscribers
 * keep their location, flattened to a JSON-safe `loc`. Also cleans up any
 * older entries for the same `(appId, version)` pair (different mtime) so
 * a re-build with a newer `.app` mtime doesn't leave stale files behind.
 * Cleanup is intentionally keyed on `(appId, version)`, not appId alone,
 * so concurrent writes for different versions of the same app (the
 * `includeAllAppVersions=true` case) don't evict each other's entries.
 */
export async function storeCachedSymbols(
  context: vscode.ExtensionContext,
  key: CacheKey,
  publishers: ReadonlyArray<Publisher>,
  subscribers: ReadonlyArray<Subscriber>,
  triggerOwners: ReadonlyArray<ObjectRef>,
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
  // Version-aware prefix: only stale-mtime entries for the SAME
  // (appId, version) pair are cleaned up. Other versions of the same
  // appId are preserved, so concurrent writes under
  // `includeAllAppVersions=true` do not evict each other.
  const versionPrefix = `${safe(key.appId)}__${safe(key.version)}__`;

  // Best-effort cleanup of older entries for the same (appId, version).
  // The directory was just created above; any failure here is purely
  // defensive and must not block the write.
  try {
    const entries = await vscode.workspace.fs.readDirectory(dir);
    for (const [name, fileType] of entries) {
      if (fileType !== vscode.FileType.File) {
        continue;
      }
      if (!name.startsWith(versionPrefix) || !name.endsWith('.json')) {
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
  const cachedSubscribers: CachedSubscriber[] = subscribers.map((s) => ({
    owner: s.owner,
    target: s.target,
    targetEvent: s.targetEvent,
    loc: {
      uri: s.location.uri.toString(),
      line: s.location.range.start.line,
      char: s.location.range.start.character
    }
  }));
  const payload: CachedPayloadV5 = {
    schemaVersion: SCHEMA_VERSION,
    publishers: strippedPublishers as Publisher[],
    subscribers: cachedSubscribers,
    triggerOwners: [...triggerOwners],
    name: meta?.name,
    appPublisher: meta?.appPublisher
  };
  await vscode.workspace.fs.writeFile(
    target,
    new TextEncoder().encode(JSON.stringify(payload))
  );
}

/**
 * Form the canonical `(appId, version)` key used by
 * `pruneOrphanCacheEntries` to decide which cache files to keep. Uses
 * the same `safe()` sanitizer as `cacheFileUri` so on-disk filenames and
 * `knownKeys` entries collate identically.
 */
export function orphanCacheKey(appId: string, version: string): string {
  return `${safe(appId)}__${safe(version)}`;
}

/**
 * One-time orphan sweep over the `symbols/` cache directory. Removes any
 * cache file whose `(appId, version)` pair is not in `knownKeys` OR
 * whose payload's `schemaVersion` is not the current `SCHEMA_VERSION`.
 * Best-effort — individual delete failures and the readDirectory failure
 * are swallowed, never thrown.
 *
 * Intended call site: tail of a successful `buildIndex` pass over
 * `.alpackages`, with `knownKeys` populated from every `(appId, version)`
 * pair visited that session (cache hit OR cache write). MUST NOT be
 * called on a partial / aborted build, since that would erase entries
 * for apps merely not visited yet.
 *
 * `knownKeys` strings are the result of `orphanCacheKey(appId, version)`
 * — one entry per `(appId, version)` pair. A filename's key is derived
 * by stripping the trailing `__<mtime>.json`.
 *
 * No-op when caching is disabled, mirroring `loadCachedSymbols` /
 * `storeCachedSymbols`.
 */
export async function pruneOrphanCacheEntries(
  context: vscode.ExtensionContext,
  knownKeys: ReadonlySet<string>
): Promise<void> {
  if (!isCacheEnabled()) {
    return;
  }
  const dir = symbolsDirUri(context);
  let entries: [string, vscode.FileType][];
  try {
    entries = await vscode.workspace.fs.readDirectory(dir);
  } catch {
    // Cache dir doesn't exist (or is unreadable) — nothing to prune.
    return;
  }
  for (const [name, fileType] of entries) {
    if (fileType !== vscode.FileType.File || !name.endsWith('.json')) {
      continue;
    }
    // Derive the `(appId, version)` key by stripping the trailing
    // `__<mtime>.json` segment. A filename without the expected
    // double-underscore + numeric mtime suffix is treated as an orphan
    // — it cannot have been produced by the current `cacheFileUri`.
    const baseName = name.slice(0, -'.json'.length);
    const lastSep = baseName.lastIndexOf('__');
    let key: string | undefined;
    if (lastSep > 0) {
      key = baseName.slice(0, lastSep);
    }

    let shouldDelete = false;
    if (key === undefined || !knownKeys.has(key)) {
      shouldDelete = true;
    } else {
      // Key matches a visited app — keep only if the payload is current
      // schema. A malformed / unreadable file at a known key is also an
      // orphan (it can't be loaded), so delete it too.
      try {
        const bytes = await vscode.workspace.fs.readFile(
          vscode.Uri.joinPath(dir, name)
        );
        const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
        const sv = (parsed as { schemaVersion?: unknown } | null)?.schemaVersion;
        if (sv !== SCHEMA_VERSION) {
          shouldDelete = true;
        }
      } catch {
        shouldDelete = true;
      }
    }
    if (!shouldDelete) {
      continue;
    }
    try {
      await vscode.workspace.fs.delete(vscode.Uri.joinPath(dir, name));
    } catch {
      // Skip any single file we can't delete; sweep is best-effort.
    }
  }
}

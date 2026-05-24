import * as vscode from 'vscode';
import { parseAl } from '../al/parser';
import { collectTriggerOwners, synthesizeTriggerPublishers } from '../al/triggers';
import { readApp, readAppMetadata } from '../symbols/appReader';
import { parseSymbolReference } from '../symbols/detect';
import { attributeToApp, discoverWorkspaceApps } from './appJson';
import {
  loadCachedSymbols,
  orphanCacheKey,
  pruneOrphanCacheEntries,
  storeCachedSymbols,
  type CacheKey
} from './cache';
import { resolveSubscribers } from './resolver';
import type { AppMeta, ObjectRef, Publisher, Subscriber } from '../al/types';
import { compareVersions } from '../util/versions';
import { mapLimit } from '../util/concurrency';

/** A fully built, resolved event index for one workspace session. */
export interface EventIndex {
  readonly publishers: ReadonlyArray<Publisher>;
  readonly subscribers: ReadonlyArray<Subscriber>;
  /** Friendly-name metadata per `appId` — both `.alpackages/*.app`
   *  dependency packages and workspace AL projects (keyed by their
   *  `app.json` `id`, flagged `isWorkspaceApp`). Missing entries fall back
   *  to the GUID at display time. */
  readonly appMeta: ReadonlyMap<string, AppMeta>;
}

/** Max file reads in flight at once during `buildIndex` (see `mapLimit`). */
const READ_CONCURRENCY = 16;

/** One `.alpackages/*.app`'s parsed contribution — produced in parallel by
 *  the Pass-2 worker, merged into the index sequentially afterwards.
 *  `version` is carried alongside `appId` so the post-merge orphan sweep
 *  can form `(appId, version)` keys for every package visited (cache hit
 *  OR cache write) this session. */
interface AppResult {
  readonly appId: string;
  readonly appVersion: string;
  readonly appName: string | undefined;
  readonly appPublisher: string | undefined;
  readonly appPublishers: Publisher[];
  readonly subscribers: Subscriber[];
  readonly triggerOwners: ObjectRef[];
}

/** Reproduces `collectTriggerOwners`' dedup key (`appId|kind|name`, name
 *  lower-cased) so trigger owners merged from a cache hit key identically
 *  to those collected fresh from bundled source. */
function triggerOwnerKey(owner: ObjectRef): string {
  return `${owner.appId ?? '__workspace__'}|${owner.kind}|${owner.name.toLowerCase()}`;
}

/**
 * Build the full event index for the current workspace: walk every `.al`
 * file under workspace folders, walk every `.app` under `.alpackages`,
 * synthesize trigger publishers, then resolve subscriber → publisher
 * links.
 *
 * Pure orchestration over the existing primitives — `parseAl`,
 * `synthesizeTriggerPublishers`, `readApp`, `parseSymbolReference`,
 * `resolveSubscribers`. All file I/O goes through `vscode.workspace.fs`
 * for VS Code Web compatibility. Per-`.app` failures are caught and
 * logged via `console.warn` so a single corrupted package never aborts
 * the whole index.
 */
export async function buildIndex(
  context: vscode.ExtensionContext,
  progress?: vscode.Progress<{ message?: string; increment?: number }>
): Promise<EventIndex> {
  const cfg = vscode.workspace.getConfiguration('alEventLens');
  const scanAlpackages = cfg.get<boolean>('scanAlpackages', true);
  const includeTriggerEvents = cfg.get<boolean>('includeTriggerEvents', true);
  const includeAllAppVersions = cfg.get<boolean>('includeAllAppVersions', false);

  const publishers: Publisher[] = [];
  const subscribers: Subscriber[] = [];
  const appMeta = new Map<string, AppMeta>();
  // One global dedup map across the entire pipeline. The key includes the
  // owning appId so identically-named objects in different packages are not
  // collapsed, but case-insensitive on name (matching the resolver) so a
  // package that bundles two spellings of "Item" / "ITEM" yields one owner.
  // The `__workspace__` sentinel covers the bare workspace pass.
  const triggerOwners = new Map<string, ObjectRef>();
  const decoder = new TextDecoder('utf-8');

  // Discover the workspace's AL projects (one per `app.json`). Used to
  // attribute each workspace `.al` file to its owning project (so the tree
  // groups multi-root workspaces per project) and to skip any `.app` in
  // `.alpackages` that is the compiled twin of an open workspace project.
  const workspaceApps = await discoverWorkspaceApps();
  // Workspace AL source is the source of truth for events (per CLAUDE.md) —
  // an open project carries `[EventSubscriber]` data the compiled `.app`
  // strips, so the workspace copy strictly supersedes the package.
  const workspaceAppIds = new Set(workspaceApps.map((a) => a.appId.toLowerCase()));
  // Register every workspace project in `appMeta` — even an `app.json` with
  // no `name`/`publisher` — so `groupByApp` can always read `isWorkspaceApp`
  // (it drives the tree's workspace-first sort and `root-folder` icon). A
  // missing `name` simply falls back to the GUID label at display time.
  for (const app of workspaceApps) {
    appMeta.set(app.appId, {
      appId: app.appId,
      name: app.name,
      appPublisher: app.appPublisher,
      isWorkspaceApp: true
    });
  }

  // Pass 1: workspace AL source files.
  progress?.report({ message: 'Scanning workspace AL files' });
  const alUris = await vscode.workspace.findFiles('**/*.al', '**/node_modules/**');
  // Read in parallel (bounded), then parse + merge sequentially below — so
  // the resulting index is identical regardless of read-completion order.
  const alFiles = await mapLimit(alUris, READ_CONCURRENCY, async (uri) => ({
    uri,
    text: decoder.decode(await vscode.workspace.fs.readFile(uri))
  }));
  for (const { uri, text } of alFiles) {
    const appId = attributeToApp(uri, workspaceApps);
    const parsed = parseAl(uri, text, appId);
    publishers.push(...parsed.publishers);
    subscribers.push(...parsed.subscribers);
    if (includeTriggerEvents) {
      collectTriggerOwners(text, triggerOwners, appId);
    }
  }

  // Pass 2: .alpackages/*.app dependency packages.
  if (scanAlpackages) {
    const allAppUris = await vscode.workspace.findFiles('**/.alpackages/*.app');
    // Read each package's NavxManifest.xml once (cheap path — no
    // SymbolReference decompression). Both steps below consult this single
    // map, so no `.app` is metadata-read twice. Skip the reads entirely when
    // neither step needs them: no workspace twins to exclude AND every
    // version is being kept.
    const metaByUri = workspaceAppIds.size > 0 || !includeAllAppVersions
      ? await readAppMetadataMap(allAppUris)
      : new Map<string, AppMetadata>();
    // Drop any `.app` that is the compiled twin of an open workspace project
    // BEFORE version selection, so the skip holds for both
    // `includeAllAppVersions` values and suppresses every version of the app.
    const candidateAppUris = workspaceAppIds.size === 0
      ? allAppUris
      : excludeWorkspaceApps(allAppUris, workspaceAppIds, metaByUri);
    const appUris = includeAllAppVersions
      ? candidateAppUris
      : selectHighestVersionPerAppId(candidateAppUris, metaByUri);
    progress?.report({
      message: `Scanning .alpackages (${appUris.length} package${appUris.length === 1 ? '' : 's'})`
    });
    // Read + parse each package in parallel (bounded). Each task owns its
    // try/catch so one bad `.app` never aborts the index; the shared-state
    // merge below runs sequentially in `appUris` order for a deterministic
    // result.
    const appResults = await mapLimit(appUris, READ_CONCURRENCY, async (uri): Promise<AppResult | undefined> => {
      try {
        const stat = await vscode.workspace.fs.stat(uri);
        // Cheap manifest-only read forms the cache key without decompressing
        // SymbolReference.json or the bundled `src/**`.
        const meta = await readAppMetadata(uri);
        const key: CacheKey = { appId: meta.appId, version: meta.version, mtime: stat.mtime };
        const cached = await loadCachedSymbols(context, key);
        if (cached) {
          // Cache hit — reuse publishers, subscribers and trigger owners;
          // skip the full `readApp` NAVX + PKZIP decompression entirely.
          return {
            appId: meta.appId,
            appVersion: meta.version,
            appName: cached.name,
            appPublisher: cached.appPublisher,
            appPublishers: cached.publishers,
            subscribers: cached.subscribers,
            triggerOwners: cached.triggerOwners
          };
        }
        // Cache miss — full read + parse, then persist for next time.
        const app = await readApp(uri);
        progress?.report({ message: `Reading ${app.name ?? app.appId}` });
        const appPublishers = parseSymbolReference(app.symbolReferenceJson, app.appId);
        // Bundled sources are parsed only for subscribers and trigger
        // owners. Publishers from bundled source are deliberately NOT
        // pushed — `parseSymbolReference` above is authoritative (per
        // CLAUDE.md). Trigger owners are collected unconditionally (not
        // gated by includeTriggerEvents) so the cache entry stays correct
        // whatever the setting is on a later run; final synthesis is gated.
        const appSubscribers: Subscriber[] = [];
        const ownerMap = new Map<string, ObjectRef>();
        for (const src of app.bundledAlSources) {
          const srcUri = vscode.Uri.parse(`al-eventlens-app:/${app.appId}/${src.path}`);
          appSubscribers.push(...parseAl(srcUri, src.text, app.appId).subscribers);
          collectTriggerOwners(src.text, ownerMap, app.appId);
        }
        const appTriggerOwners = [...ownerMap.values()];
        await storeCachedSymbols(
          context, key, appPublishers, appSubscribers, appTriggerOwners,
          { name: app.name, appPublisher: app.appPublisher }
        );
        return {
          appId: app.appId,
          appVersion: meta.version,
          appName: app.name,
          appPublisher: app.appPublisher,
          appPublishers,
          subscribers: appSubscribers,
          triggerOwners: appTriggerOwners
        };
      } catch (err) {
        console.warn(`AL EventLens: failed to read ${uri.fsPath}: ${err}`);
        return undefined;
      }
    });
    // Sequential merge — `appUris` order, so the index is deterministic.
    // `visitedKeys` collects one `(appId, version)` entry per package that
    // contributed to the index this session (cache hit OR cache write);
    // it feeds the orphan sweep below.
    const visitedKeys = new Set<string>();
    for (const r of appResults) {
      if (!r) {
        continue;
      }
      if (r.appName !== undefined || r.appPublisher !== undefined) {
        appMeta.set(r.appId, { appId: r.appId, name: r.appName, appPublisher: r.appPublisher });
      }
      publishers.push(...r.appPublishers);
      subscribers.push(...r.subscribers);
      // Merge trigger owners into the global dedup map; `triggerOwnerKey`
      // reproduces `collectTriggerOwners`' key so cache-hit and cache-miss
      // results dedupe identically.
      for (const owner of r.triggerOwners) {
        triggerOwners.set(triggerOwnerKey(owner), owner);
      }
      visitedKeys.add(orphanCacheKey(r.appId, r.appVersion));
    }
    // Best-effort one-time orphan sweep — drops cache files for apps no
    // longer present in `.alpackages` and any pre-current-schema files
    // left behind by older releases. Runs only after Pass 2 finishes
    // normally (any earlier throw skips this naturally); failures are
    // logged but never block the index.
    try {
      await pruneOrphanCacheEntries(context, visitedKeys);
    } catch (err) {
      console.warn(`AL EventLens: cache orphan sweep failed: ${err}`);
    }
  }

  if (includeTriggerEvents) {
    progress?.report({ message: 'Synthesizing trigger publishers' });
    for (const owner of triggerOwners.values()) {
      publishers.push(...synthesizeTriggerPublishers(owner));
    }
  }

  progress?.report({ message: 'Resolving subscriber links' });
  const resolved = resolveSubscribers(publishers, subscribers);
  return { publishers, subscribers: resolved, appMeta };
}

/** Manifest metadata for one `.alpackages/*.app` package. */
interface AppMetadata {
  readonly appId: string;
  readonly version: string;
}

/**
 * Read the `NavxManifest.xml` metadata (`appId`, `version`) for every `.app`
 * URI once, into a map keyed by `uri.toString()`. Cheap path — reads only the
 * manifest, never `SymbolReference.json` or bundled `src/**`, so a package
 * dropped by the steps below never pays the full-parse cost.
 *
 * A per-file read failure is `console.warn`-ed once and the URI left absent
 * from the map; the two consumers decide what an absent entry means
 * (`excludeWorkspaceApps` keeps it, `selectHighestVersionPerAppId` drops it).
 */
async function readAppMetadataMap(
  uris: ReadonlyArray<vscode.Uri>
): Promise<Map<string, AppMetadata>> {
  const entries = await mapLimit(
    uris,
    READ_CONCURRENCY,
    async (uri): Promise<readonly [string, AppMetadata] | undefined> => {
      try {
        return [uri.toString(), await readAppMetadata(uri)];
      } catch (err) {
        console.warn(`AL EventLens: failed to read metadata from ${uri.fsPath}: ${err}`);
        return undefined;
      }
    }
  );
  const out = new Map<string, AppMetadata>();
  for (const entry of entries) {
    if (entry) {
      out.set(entry[0], entry[1]);
    }
  }
  return out;
}

/**
 * Drop every `.app` URI whose manifest `appId` belongs to an AL project that
 * is open in the workspace as `.al` source. Workspace source is authoritative
 * (it carries `[EventSubscriber]` data `SymbolReference.json` strips at
 * compile time, per CLAUDE.md), so skipping the compiled twin loses nothing
 * and prevents the same app's events being indexed twice.
 *
 * Pure over the pre-read `metaByUri` map (see `readAppMetadataMap`) — no I/O.
 * `workspaceAppIds` is a set of **lowercased** GUIDs, since GUID casing varies
 * between `app.json` and `NavxManifest.xml`. A URI absent from `metaByUri`
 * (its metadata read failed) is **kept**, so the main `readApp` loop's
 * existing try/catch still reports it rather than it being silently dropped.
 */
function excludeWorkspaceApps(
  uris: ReadonlyArray<vscode.Uri>,
  workspaceAppIds: ReadonlySet<string>,
  metaByUri: ReadonlyMap<string, AppMetadata>
): vscode.Uri[] {
  const kept: vscode.Uri[] = [];
  for (const uri of uris) {
    const meta = metaByUri.get(uri.toString());
    if (meta && workspaceAppIds.has(meta.appId.toLowerCase())) {
      continue;
    }
    kept.push(uri);
  }
  return kept;
}

/**
 * Group `.app` URIs by their manifest `appId` and return only the
 * highest-`Version` URI per group.
 *
 * Pure over the pre-read `metaByUri` map (see `readAppMetadataMap`) — no I/O.
 * A URI absent from `metaByUri` had its metadata read fail earlier (already
 * warned) and is dropped.
 *
 * Tie-break: when two `.app` files share the same `appId` AND identical
 * `Version`, pick deterministically (first URI by `toString()` order) and
 * `console.warn` the collision so the user can clean up the folder.
 */
function selectHighestVersionPerAppId(
  uris: ReadonlyArray<vscode.Uri>,
  metaByUri: ReadonlyMap<string, AppMetadata>
): vscode.Uri[] {
  const winners = new Map<string, { uri: vscode.Uri; version: string }>();
  // Deterministic order so ties resolve the same way every run.
  const sortedUris = [...uris].sort((a, b) => a.toString().localeCompare(b.toString()));
  for (const uri of sortedUris) {
    const meta = metaByUri.get(uri.toString());
    if (!meta) {
      // Metadata read failed earlier (already warned) — drop the URI.
      continue;
    }
    const existing = winners.get(meta.appId);
    if (!existing) {
      winners.set(meta.appId, { uri, version: meta.version });
      continue;
    }
    const cmp = compareVersions(meta.version, existing.version);
    if (cmp > 0) {
      winners.set(meta.appId, { uri, version: meta.version });
    } else if (cmp === 0) {
      console.warn(
        `AL EventLens: duplicate .app for appId=${meta.appId} version=${meta.version} ` +
        `(keeping ${existing.uri.fsPath}, skipping ${uri.fsPath})`
      );
    }
    // cmp < 0: existing already higher, keep it.
  }
  return [...winners.values()].map((v) => v.uri);
}

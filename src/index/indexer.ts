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

/** One workspace `.al` file's parsed contribution — produced in parallel
 *  by the Pass-1 worker, merged into the index sequentially afterwards
 *  in `alUris` order so the resulting index is deterministic. Holding
 *  the parsed shape (not raw text) caps peak heap at one decoded file
 *  per in-flight worker rather than every file's text at once. */
interface AlPassResult {
  readonly publishers: Publisher[];
  readonly subscribers: Subscriber[];
  /** Trigger-owner ObjectRefs collected from this file's Tables and Pages,
   *  each paired with the declaring file's URI so the synthesis step can
   *  tag the resulting publishers with `sourceUri` (lets the save-survival
   *  filter evict them on a subsequent save instead of accumulating
   *  duplicates — see issue #107).
   *  `undefined` when `includeTriggerEvents` is false (the worker skips
   *  the work entirely); a per-file dedup map is flattened into an array
   *  for the sequential merge to fold into the global map. */
  readonly triggerOwnerEntries: WorkspaceTriggerOwner[] | undefined;
}

/** Pairing of a workspace-pass trigger-owner ObjectRef with the URI of the
 *  `.al` file that declared it. Used to feed `synthesizeTriggerPublishers`
 *  with a non-undefined `sourceUri` so the save-survival filter can replace
 *  these synthesized publishers cleanly on re-save (see issue #107). `.app`-
 *  bundled trigger owners deliberately do NOT carry a `sourceUri` — they
 *  have no workspace source file, so their `undefined` sourceUri means a
 *  workspace save can never evict them (correct: bundled triggers must
 *  survive a workspace-side save). */
interface WorkspaceTriggerOwner {
  readonly owner: ObjectRef;
  readonly sourceUri: vscode.Uri;
}

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

/** Reproduces `collectTriggerOwners`' dedup key (`appId|kind|name`, both
 *  `appId` and `name` lower-cased) so trigger owners merged from a cache hit
 *  key identically to those collected fresh from bundled source. GUID casing
 *  varies between `app.json` `id` and `NavxManifest.xml` `Id`, so the appId
 *  scope must be case-insensitive — matching the twin-exclusion
 *  normalization (`workspaceAppIds`) used elsewhere. */
function triggerOwnerKey(owner: ObjectRef): string {
  return `${owner.appId?.toLowerCase() ?? '__workspace__'}|${owner.kind}|${owner.name.toLowerCase()}`;
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
  // Two dedup maps, one per source-axis, so the synthesis step can tag
  // workspace-pass triggers with `sourceUri` while `.app`-bundled triggers
  // stay un-tagged (their `sourceUri` must remain undefined so a workspace
  // save can never evict them — see issue #107). Keys are the same shape
  // (`appId|kind|name`, name lower-cased, `__workspace__` sentinel for loose
  // `.al` files under no `app.json`), so the synthesis loop can detect a key
  // present in both maps and prefer the workspace entry (workspace source
  // strictly supersedes the compiled package, per CLAUDE.md).
  const workspaceTriggerOwners = new Map<string, WorkspaceTriggerOwner>();
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
  // Read AND parse in parallel (bounded). Each worker returns the parsed
  // shape — publishers, subscribers, and (when enabled) per-file trigger
  // owners — so peak heap is one decoded `.al` file's text per in-flight
  // worker, not every file's text held at once. `parseAl` is pure given
  // `(uri, text, appId)`, so iterating the results in `alUris` order below
  // keeps the merged index deterministic regardless of read-completion
  // order.
  //
  // Error handling is split into two layers because the two failure modes
  // deserve different treatment (see issue #115):
  //   1. Read failures (I/O errors) — transient and expected occasionally
  //      (antivirus lock, sync client, file deleted between `findFiles`
  //      and `readFile`). Caught inline, `console.warn`'d, slot returns
  //      `undefined` so the rest of the index survives.
  //   2. Parse failures (`parseAl` / `collectTriggerOwners` throwing) —
  //      bugs in our code that should be loud. Caught only to log the
  //      offending file path at error level, then re-thrown so the whole
  //      `mapLimit` rejects and `buildIndex`'s extension-level `.catch`
  //      surfaces the failure to the user instead of silently dropping
  //      that file's events.
  // No `onError: 'skip'` on the outer call — I/O errors are pre-swallowed
  // inline, so the only rejections that can propagate are genuine parser
  // bugs that we want to surface.
  const alFiles = await mapLimit(
    alUris,
    READ_CONCURRENCY,
    async (uri): Promise<AlPassResult | undefined> => {
      let text: string;
      try {
        text = decoder.decode(await vscode.workspace.fs.readFile(uri));
      } catch (err) {
        console.warn(`AL EventLens: failed to read .al file ${uri.fsPath}: ${err}`);
        return undefined;
      }
      try {
        const appId = attributeToApp(uri, workspaceApps);
        const parsed = parseAl(uri, text, appId);
        let triggerOwnerEntries: WorkspaceTriggerOwner[] | undefined;
        if (includeTriggerEvents) {
          const ownerMap = new Map<string, ObjectRef>();
          collectTriggerOwners(text, ownerMap, appId);
          // Pair every collected owner with this file's URI so the synthesis
          // step can tag the resulting publishers with `sourceUri` — the
          // save-survival filter keys on it to evict the previous set on a
          // subsequent save (see issue #107).
          triggerOwnerEntries = [...ownerMap.values()].map((owner) => ({ owner, sourceUri: uri }));
        }
        return {
          publishers: parsed.publishers,
          subscribers: parsed.subscribers,
          triggerOwnerEntries
        };
      } catch (err) {
        console.error(
          `AL EventLens parser bug: parseAl threw on ${uri.fsPath} -- please report this`,
          err
        );
        // Wrap with a recognizable marker prefix so `extension.ts`'s
        // activation catch can distinguish parser bugs from transient
        // I/O errors and surface them via `showErrorMessage` — users
        // never see the `console.error` above. Preserve the original
        // error as `.cause` so a future inspector still has the stack.
        const wrapped = new Error(
          `[AL EventLens parser bug] ${err instanceof Error ? err.message : String(err)} (in ${uri.fsPath})`
        );
        (wrapped as { cause?: unknown }).cause = err;
        throw wrapped;
      }
    }
  );
  for (const result of alFiles) {
    if (!result) {
      continue;
    }
    publishers.push(...result.publishers);
    subscribers.push(...result.subscribers);
    if (result.triggerOwnerEntries) {
      // First-write-wins dedup (matches the pre-existing semantics) so the
      // surviving entry is the one whose `sourceUri` points at the FIRST
      // `.al` file that declared the Table/Page — deterministic in
      // `alUris` order. Subsequent declarations (rare; duplicate-id error
      // for the user's AL compiler) are skipped silently.
      for (const entry of result.triggerOwnerEntries) {
        const key = triggerOwnerKey(entry.owner);
        if (!workspaceTriggerOwners.has(key)) {
          workspaceTriggerOwners.set(key, entry);
        }
      }
    }
  }

  // Pass 2: .alpackages/*.app dependency packages.
  if (scanAlpackages) {
    const allAppUris = await vscode.workspace.findFiles('**/.alpackages/*.app');
    // Read each package's NavxManifest.xml once (cheap path — no
    // SymbolReference decompression). Every step below consults this single
    // map — workspace-twin exclusion, version selection, and the
    // same-`(appId, version)` dedup that both selection paths now perform —
    // so the map is always built and no `.app` is metadata-read twice.
    const metaByUri = await readAppMetadataMap(allAppUris);
    // Drop any `.app` that is the compiled twin of an open workspace project
    // BEFORE version selection, so the skip holds for both
    // `includeAllAppVersions` values and suppresses every version of the app.
    // An excluded twin may leave a still-valid-schema cache entry behind in
    // the shared `globalStorageUri/symbols/` dir — that is intentional:
    // `pruneOrphanCacheEntries` deliberately sweeps only schema-mismatched
    // files (the storage is shared across every workspace ever indexed, so a
    // "not visited this run → delete" rule would evict other workspaces'
    // entries). The lingering entry is never read (the appId is excluded
    // from Pass 2) and is reclaimed on the next schema bump (issue #133 D6).
    const candidateAppUris = workspaceAppIds.size === 0
      ? allAppUris
      : excludeWorkspaceApps(allAppUris, workspaceAppIds, metaByUri);
    // Even under `includeAllAppVersions`, collapse byte-for-byte-redundant
    // copies of the same `(appId, version)` (e.g. the same dependency staged
    // in two projects' `.alpackages` across a multi-root workspace) so two
    // identical packages never both enter the read/write pool and race the
    // per-write cache-cleanup sweep in `storeCachedSymbols`, evicting each
    // other's freshly-written file (issue #129). Genuinely distinct versions
    // carry a different key and all survive — `includeAllAppVersions`
    // semantics are unchanged.
    const appUris = includeAllAppVersions
      ? dedupByAppIdVersion(candidateAppUris, metaByUri)
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
        // Prefer the manifest metadata already read by `readAppMetadataMap`
        // above — `readAppMetadata` re-opens the NAVX zip per call, so on
        // a cold start over many packages reusing the map halves the
        // per-package work on a cache hit. The map is now always built, so
        // the fall-through only covers a single URI whose manifest read
        // failed during the map pass (such a URI is kept by the selection
        // helpers so this loop's try/catch can surface the failure).
        const meta = metaByUri.get(uri.toString()) ?? await readAppMetadata(uri);
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
        // Preserve an existing `isWorkspaceApp: true` flag set earlier
        // for the workspace project that owns this appId. The
        // `excludeWorkspaceApps` short-circuit keeps a `.app` whose
        // metadata read transiently failed, so a workspace twin can
        // slip past exclusion; without this guard the Pass-2 merge
        // would unconditionally overwrite the entry and strip the
        // flag, dropping the workspace-first sort and `root-folder`
        // icon downstream (see treeView.ts / subscriberTreeView.ts).
        const prev = appMeta.get(r.appId);
        appMeta.set(r.appId, {
          appId: r.appId,
          name: r.appName,
          appPublisher: r.appPublisher,
          ...(prev?.isWorkspaceApp ? { isWorkspaceApp: true } : {})
        });
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
    // Best-effort one-time schema-mismatch sweep — drops any
    // pre-current-schema cache files left behind by older releases.
    // Runs only after Pass 2 finishes normally (any earlier throw skips
    // this naturally); failures are logged but never block the index.
    // Belt-and-suspenders: skip entirely when this workspace contributed
    // no visited packages — there's nothing useful for the sweep to
    // decide on, and `globalStorageUri/symbols/` is shared with other
    // workspaces whose cached entries we must not touch.
    if (visitedKeys.size > 0) {
      try {
        await pruneOrphanCacheEntries(context, visitedKeys);
      } catch (err) {
        console.warn(`AL EventLens: cache orphan sweep failed: ${err}`);
      }
    }
  }

  if (includeTriggerEvents) {
    progress?.report({ message: 'Synthesizing trigger publishers' });
    // Workspace-pass triggers first, tagged with the declaring `.al` URI so
    // the save-survival filter can evict the previous set on a subsequent
    // save (see issue #107).
    for (const entry of workspaceTriggerOwners.values()) {
      publishers.push(...synthesizeTriggerPublishers(entry.owner, entry.sourceUri));
    }
    // `.app`-bundled triggers next, NOT tagged with a `sourceUri` (these
    // have no workspace source file; `undefined` is what keeps them safe
    // from workspace-save eviction). Skip any key already contributed by
    // the workspace pass — workspace source supersedes the compiled twin
    // per CLAUDE.md.
    for (const [key, owner] of triggerOwners) {
      if (workspaceTriggerOwners.has(key)) {
        continue;
      }
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

/**
 * Collapse `.app` URIs that are byte-for-byte-redundant copies of the same
 * `(appId, version)` — e.g. the same dependency staged in two projects'
 * `.alpackages` across a multi-root workspace, differing only by file
 * `mtime`. Keeps the first URI per `(appId, version)` in deterministic
 * sorted order and drops the rest, `console.warn`ing each collapsed copy.
 *
 * Used on the `includeAllAppVersions = true` path, where
 * `selectHighestVersionPerAppId` is bypassed. Genuinely distinct versions
 * carry a different `orphanCacheKey`, so they all survive and
 * `includeAllAppVersions` still surfaces every version; only same-version
 * twins — which can never coexist in the cache anyway and would race the
 * per-write cleanup sweep in `storeCachedSymbols`, evicting each other's
 * freshly-written files (issue #129) — are removed before the read/write
 * pool.
 *
 * Pure over the pre-read `metaByUri` map (see `readAppMetadataMap`) — no
 * I/O. A URI absent from `metaByUri` (its metadata read failed) is **kept**
 * — matching `excludeWorkspaceApps` — so the main `readApp` loop's try/catch
 * still reports it. Two no-metadata URIs cannot form a key and are both
 * kept; that is safe, since a failed read writes no cache file.
 */
function dedupByAppIdVersion(
  uris: ReadonlyArray<vscode.Uri>,
  metaByUri: ReadonlyMap<string, AppMetadata>
): vscode.Uri[] {
  const seen = new Map<string, vscode.Uri>();
  const kept: vscode.Uri[] = [];
  // Deterministic order so the kept copy is stable across runs.
  const sortedUris = [...uris].sort((a, b) => a.toString().localeCompare(b.toString()));
  for (const uri of sortedUris) {
    const meta = metaByUri.get(uri.toString());
    if (!meta) {
      // Metadata unread — keep so the `readApp` loop surfaces the failure.
      kept.push(uri);
      continue;
    }
    const key = orphanCacheKey(meta.appId, meta.version);
    const existing = seen.get(key);
    if (existing) {
      console.warn(
        `AL EventLens: duplicate .app for appId=${meta.appId} version=${meta.version} ` +
        `(keeping ${existing.fsPath}, skipping ${uri.fsPath})`
      );
      continue;
    }
    seen.set(key, uri);
    kept.push(uri);
  }
  return kept;
}

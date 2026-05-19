import * as vscode from 'vscode';
import { parseAl } from '../al/parser';
import { collectTriggerOwners, synthesizeTriggerPublishers } from '../al/triggers';
import { readApp, readAppMetadata } from '../symbols/appReader';
import { parseSymbolReference } from '../symbols/detect';
import { loadCachedSymbols, storeCachedSymbols, type CacheKey } from './cache';
import { resolveSubscribers } from './resolver';
import type { AppMeta, ObjectRef, Publisher, Subscriber } from '../al/types';
import { compareVersions } from '../util/versions';

/** A fully built, resolved event index for one workspace session. */
export interface EventIndex {
  readonly publishers: ReadonlyArray<Publisher>;
  readonly subscribers: ReadonlyArray<Subscriber>;
  /** Friendly-name metadata per dependency `appId`. Workspace publishers
   *  contribute nothing; missing entries fall back to the GUID at display time. */
  readonly appMeta: ReadonlyMap<string, AppMeta>;
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

  // Pass 1: workspace AL source files.
  progress?.report({ message: 'Scanning workspace AL files' });
  const alUris = await vscode.workspace.findFiles('**/*.al', '**/node_modules/**');
  for (const uri of alUris) {
    const bytes = await vscode.workspace.fs.readFile(uri);
    const text = decoder.decode(bytes);
    const parsed = parseAl(uri, text);
    publishers.push(...parsed.publishers);
    subscribers.push(...parsed.subscribers);
    if (includeTriggerEvents) {
      collectTriggerOwners(text, triggerOwners);
    }
  }

  // Pass 2: .alpackages/*.app dependency packages.
  if (scanAlpackages) {
    const allAppUris = await vscode.workspace.findFiles('**/.alpackages/*.app');
    const appUris = includeAllAppVersions
      ? allAppUris
      : await selectHighestVersionPerAppId(allAppUris);
    progress?.report({
      message: `Scanning .alpackages (${appUris.length} package${appUris.length === 1 ? '' : 's'})`
    });
    for (const uri of appUris) {
      try {
        const stat = await vscode.workspace.fs.stat(uri);
        const app = await readApp(uri);
        const key: CacheKey = { appId: app.appId, version: app.version, mtime: stat.mtime };
        const cached = await loadCachedSymbols(context, key);
        let appPublishers: Publisher[];
        let appName: string | undefined;
        let appPublisher: string | undefined;
        if (cached) {
          appPublishers = cached.publishers;
          appName = cached.name;
          appPublisher = cached.appPublisher;
        } else {
          progress?.report({ message: `Reading ${app.name ?? app.appId}` });
          appPublishers = parseSymbolReference(app.symbolReferenceJson, app.appId);
          appName = app.name;
          appPublisher = app.appPublisher;
          await storeCachedSymbols(context, key, appPublishers, { name: appName, appPublisher });
        }
        if (appName !== undefined || appPublisher !== undefined) {
          appMeta.set(app.appId, { appId: app.appId, name: appName, appPublisher });
        }
        publishers.push(...appPublishers);
        // Bundled sources are parsed only for subscribers and trigger
        // owners. Publishers from bundled source are deliberately NOT
        // pushed — `parseSymbolReference` above is authoritative for
        // publishers (per CLAUDE.md), and pushing both would duplicate
        // every event under any `.app` that ships its own `src/*.al`.
        // Subscriber-side data is not cached because `vscode.Location`
        // is not JSON-safe.
        for (const src of app.bundledAlSources) {
          const srcUri = vscode.Uri.parse(`al-eventlens-app:/${app.appId}/${src.path}`);
          const parsed = parseAl(srcUri, src.text);
          subscribers.push(...parsed.subscribers);
          if (includeTriggerEvents) {
            collectTriggerOwners(src.text, triggerOwners, app.appId);
          }
        }
      } catch (err) {
        console.warn(`AL EventLens: failed to read ${uri.fsPath}: ${err}`);
        continue;
      }
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

/**
 * Group `.app` URIs by their manifest `appId` and return only the
 * highest-`Version` URI per group. Cheap-path: reads only `NavxManifest.xml`
 * (via `readAppMetadata`), not `SymbolReference.json` or bundled `src/**`,
 * so losers don't pay the full-parse cost.
 *
 * Tie-break: when two `.app` files share the same `appId` AND identical
 * `Version`, pick deterministically (first URI by `toString()` order) and
 * `console.warn` the collision so the user can clean up the folder.
 *
 * Per-file metadata-read failures are tolerated the same way the main
 * `readApp` loop tolerates parse failures — `console.warn` + continue, so a
 * single bad `.app` cannot abort the dedupe pass.
 */
async function selectHighestVersionPerAppId(
  uris: ReadonlyArray<vscode.Uri>
): Promise<vscode.Uri[]> {
  const winners = new Map<string, { uri: vscode.Uri; version: string }>();
  // Deterministic order so ties resolve the same way every run.
  const sortedUris = [...uris].sort((a, b) => a.toString().localeCompare(b.toString()));
  for (const uri of sortedUris) {
    let meta: { appId: string; version: string };
    try {
      meta = await readAppMetadata(uri);
    } catch (err) {
      console.warn(`AL EventLens: failed to read metadata from ${uri.fsPath}: ${err}`);
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

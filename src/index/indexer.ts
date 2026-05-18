import * as vscode from 'vscode';
import { parseAl } from '../al/parser';
import { collectTriggerOwners, synthesizeTriggerPublishers } from '../al/triggers';
import { readApp } from '../symbols/appReader';
import { parseSymbolReference } from '../symbols/detect';
import { loadCachedSymbols, storeCachedSymbols, type CacheKey } from './cache';
import { resolveSubscribers } from './resolver';
import type { AppMeta, ObjectRef, Publisher, Subscriber } from '../al/types';

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
    const appUris = await vscode.workspace.findFiles('**/.alpackages/*.app');
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
        // Subscribers from bundled sources are NOT cached; bundled-source
        // subscribers must be re-parsed every run since they carry
        // `vscode.Location` references that aren't JSON-safe.
        for (const src of app.bundledAlSources) {
          const srcUri = vscode.Uri.parse(`al-eventlens-app:/${app.appId}/${src.path}`);
          const parsed = parseAl(srcUri, src.text);
          publishers.push(...parsed.publishers);
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

import * as assert from 'assert';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { ObjectRef, Publisher, Subscriber } from '../../al/types';
import {
  loadCachedSymbols,
  pruneOrphanCacheEntries,
  storeCachedSymbols,
  type CacheKey
} from '../../index/cache';

// ─── Helpers ─────────────────────────────────────────────────────────────

function makeFakeContext(globalStorageUri: vscode.Uri): vscode.ExtensionContext {
  // The cache only ever reads `globalStorageUri`. Everything else on
  // ExtensionContext is irrelevant here; cast through `unknown` to avoid
  // listing dozens of unused fields.
  return { globalStorageUri } as unknown as vscode.ExtensionContext;
}

function makePublisher(name: string, eventName: string): Publisher {
  return {
    owner: { kind: 'codeunit', name },
    eventName,
    kind: 'integration'
  };
}

function makeSubscriber(targetName: string, targetEvent: string): Subscriber {
  return {
    owner: { kind: 'codeunit', name: 'My Sub' },
    target: { kind: 'codeunit', name: targetName },
    targetEvent,
    location: new vscode.Location(
      vscode.Uri.parse('al-eventlens-app:/app/src/Sub.al'),
      new vscode.Position(12, 4)
    ),
    resolved: true
  };
}

// Adapter for the v5 storeCachedSymbols signature — most tests here only
// exercise publishers, so subscribers / triggerOwners default to empty.
function store(
  context: vscode.ExtensionContext,
  key: CacheKey,
  publishers: Publisher[],
  meta?: { name?: string; appPublisher?: string }
): Promise<void> {
  return storeCachedSymbols(context, key, publishers, [], [], meta);
}

async function rmrf(uri: vscode.Uri): Promise<void> {
  try {
    await vscode.workspace.fs.delete(uri, { recursive: true, useTrash: false });
  } catch {
    // already gone
  }
}

let tmpRoot: vscode.Uri;
let ctx: vscode.ExtensionContext;
let originalCacheEnabled: boolean | undefined;

async function setEnabled(value: boolean): Promise<void> {
  await vscode.workspace
    .getConfiguration('alEventLens')
    .update('cache.enabled', value, vscode.ConfigurationTarget.Global);
}

async function clearEnabled(): Promise<void> {
  await vscode.workspace
    .getConfiguration('alEventLens')
    .update('cache.enabled', undefined, vscode.ConfigurationTarget.Global);
}

// ─── Tests ───────────────────────────────────────────────────────────────

suite('index/cache: loadCachedSymbols + storeCachedSymbols', () => {
  setup(async () => {
    const unique = `al-eventlens-cache-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    tmpRoot = vscode.Uri.file(path.join(os.tmpdir(), unique));
    await vscode.workspace.fs.createDirectory(tmpRoot);
    ctx = makeFakeContext(tmpRoot);
    originalCacheEnabled = vscode.workspace
      .getConfiguration('alEventLens')
      .get<boolean>('cache.enabled');
  });

  teardown(async () => {
    if (originalCacheEnabled === undefined) {
      await clearEnabled();
    } else {
      await setEnabled(originalCacheEnabled);
    }
    await rmrf(tmpRoot);
  });

  test('cold cache returns undefined', async () => {
    const result = await loadCachedSymbols(ctx, { appId: 'X', version: '1.0', mtime: 100 });
    assert.strictEqual(result, undefined);
  });

  test('round-trip: store then load yields equivalent publishers', async () => {
    const key: CacheKey = { appId: 'X', version: '1.0', mtime: 100 };
    const p1 = makePublisher('Sales-Post', 'OnAfterPostSalesDoc');
    const p2 = makePublisher('Sales-Post', 'OnBeforePostSalesDoc');
    await store(ctx, key, [p1, p2]);

    const loaded = await loadCachedSymbols(ctx, key);
    assert.ok(loaded);
    assert.strictEqual(loaded!.publishers.length, 2);
    assert.deepStrictEqual(loaded!.publishers[0], { owner: p1.owner, eventName: p1.eventName, kind: p1.kind });
    assert.deepStrictEqual(loaded!.publishers[1], { owner: p2.owner, eventName: p2.eventName, kind: p2.kind });
    assert.strictEqual(loaded!.name, undefined, 'no meta stored → name undefined');
    assert.strictEqual(loaded!.appPublisher, undefined, 'no meta stored → appPublisher undefined');
  });

  test('round-trip: friendly-name metadata (name, appPublisher) survives store/load', async () => {
    const key: CacheKey = { appId: 'meta-app', version: '1.0', mtime: 100 };
    await store(ctx, key, [makePublisher('A', 'OnFoo')], {
      name: 'Sample App',
      appPublisher: 'Acme Corp'
    });
    const loaded = await loadCachedSymbols(ctx, key);
    assert.ok(loaded);
    assert.strictEqual(loaded!.name, 'Sample App');
    assert.strictEqual(loaded!.appPublisher, 'Acme Corp');
    assert.strictEqual(loaded!.publishers.length, 1);
  });

  test('old (v1) bare-array cache files are silently ignored on load', async () => {
    const key: CacheKey = { appId: 'X', version: '1.0', mtime: 100 };
    const symbolsDir = vscode.Uri.joinPath(tmpRoot, 'symbols');
    await vscode.workspace.fs.createDirectory(symbolsDir);
    const target = vscode.Uri.joinPath(symbolsDir, `${key.appId}__${key.version}__${key.mtime}.json`);
    // v1 shape: bare publisher array, no schemaVersion / wrapper.
    await vscode.workspace.fs.writeFile(
      target,
      new TextEncoder().encode(JSON.stringify([
        { owner: { kind: 'codeunit', name: 'Old' }, eventName: 'OnLegacy', kind: 'integration' }
      ]))
    );
    const result = await loadCachedSymbols(ctx, key);
    assert.strictEqual(result, undefined,
      'v1 cache payloads must be treated as misses so the indexer re-parses and captures friendly-name metadata');
  });

  test('old (v2) cache payloads are silently ignored on load — v3 added per-publisher parameters', async () => {
    const key: CacheKey = { appId: 'X', version: '1.0', mtime: 100 };
    const symbolsDir = vscode.Uri.joinPath(tmpRoot, 'symbols');
    await vscode.workspace.fs.createDirectory(symbolsDir);
    const target = vscode.Uri.joinPath(symbolsDir, `${key.appId}__${key.version}__${key.mtime}.json`);
    // v2 shape: wrapper with schemaVersion: 2 and publishers lacking `parameters`.
    await vscode.workspace.fs.writeFile(
      target,
      new TextEncoder().encode(JSON.stringify({
        schemaVersion: 2,
        publishers: [
          { owner: { kind: 'codeunit', name: 'Old' }, eventName: 'OnLegacy', kind: 'integration' }
        ],
        name: 'Sample',
        appPublisher: 'Acme'
      }))
    );
    const result = await loadCachedSymbols(ctx, key);
    assert.strictEqual(result, undefined,
      'v2 cache payloads must be treated as misses so the indexer re-parses and captures signature parameters');
  });

  test('old (v3) cache payloads are silently ignored on load — v4 invalidates entries poisoned by the namespace-walk bug', async () => {
    const key: CacheKey = { appId: 'X', version: '1.0', mtime: 100 };
    const symbolsDir = vscode.Uri.joinPath(tmpRoot, 'symbols');
    await vscode.workspace.fs.createDirectory(symbolsDir);
    const target = vscode.Uri.joinPath(symbolsDir, `${key.appId}__${key.version}__${key.mtime}.json`);
    // v3 shape: identical on-disk layout to v4, but the publisher list could
    // be missing everything inside Namespaces[] because the old dispatcher
    // routed string inputs to the flat-only parser.
    await vscode.workspace.fs.writeFile(
      target,
      new TextEncoder().encode(JSON.stringify({
        schemaVersion: 3,
        publishers: [
          { owner: { kind: 'codeunit', name: 'Stale', appId: 'X' }, eventName: 'OnStale', kind: 'integration' }
        ],
        name: 'Sample',
        appPublisher: 'Acme'
      }))
    );
    const result = await loadCachedSymbols(ctx, key);
    assert.strictEqual(result, undefined,
      'v3 cache payloads must be treated as misses so the indexer re-parses with the fixed namespace walk');
  });

  test('round-trip: publisher parameters survive store/load (v4)', async () => {
    const key: CacheKey = { appId: 'X', version: '1.0', mtime: 100 };
    const pub: Publisher = {
      owner: { kind: 'codeunit', name: 'Sales-Post', appId: 'X' },
      eventName: 'OnAfterPost',
      kind: 'integration',
      parameters: [
        { name: 'SalesHeader', typeText: 'Record "Sales Header"', isVar: true },
        { name: 'CommitIsSuppressed', typeText: 'Boolean', isVar: false }
      ]
    };
    await store(ctx, key, [pub]);
    const loaded = await loadCachedSymbols(ctx, key);
    assert.ok(loaded, 'cache must hit on round-trip');
    assert.deepStrictEqual(loaded!.publishers[0].parameters, [
      { name: 'SalesHeader', typeText: 'Record "Sales Header"', isVar: true },
      { name: 'CommitIsSuppressed', typeText: 'Boolean', isVar: false }
    ]);
  });

  test('round-trip: publisher with no parameters field round-trips without a `parameters` key', async () => {
    // Distinguishes the "no signature info" case (undefined) from "no params"
    // (empty array). Both are valid; the cache must preserve the distinction.
    const key: CacheKey = { appId: 'X', version: '1.0', mtime: 100 };
    await store(ctx, key, [makePublisher('A', 'OnFoo')]);
    const loaded = await loadCachedSymbols(ctx, key);
    assert.ok(loaded);
    assert.strictEqual(loaded!.publishers[0].parameters, undefined);
  });

  test('mtime mismatch returns undefined', async () => {
    const stored: CacheKey = { appId: 'X', version: '1.0', mtime: 1000 };
    await store(ctx, stored, [makePublisher('A', 'OnFoo')]);

    const stale: CacheKey = { appId: 'X', version: '1.0', mtime: 2000 };
    const result = await loadCachedSymbols(ctx, stale);
    assert.strictEqual(result, undefined);
  });

  test('settings gating: cache.enabled=false makes load return undefined even after a prior store', async () => {
    const key: CacheKey = { appId: 'X', version: '1.0', mtime: 100 };
    // Store with caching enabled (default).
    await setEnabled(true);
    await store(ctx, key, [makePublisher('A', 'OnFoo')]);
    // Sanity check: enabled load works.
    const enabledLoad = await loadCachedSymbols(ctx, key);
    assert.ok(enabledLoad);

    // Now disable and confirm load returns undefined.
    await setEnabled(false);
    const disabledLoad = await loadCachedSymbols(ctx, key);
    assert.strictEqual(disabledLoad, undefined);
  });

  test('settings gating: cache.enabled=false makes store a no-op', async () => {
    await setEnabled(false);
    const key: CacheKey = { appId: 'X', version: '1.0', mtime: 100 };
    await store(ctx, key, [makePublisher('A', 'OnFoo')]);

    // The symbols/ directory should either not exist or contain no
    // matching files. Both outcomes satisfy "nothing was written".
    const symbolsDir = vscode.Uri.joinPath(tmpRoot, 'symbols');
    let entries: [string, vscode.FileType][] = [];
    try {
      entries = await vscode.workspace.fs.readDirectory(symbolsDir);
    } catch {
      // dir doesn't exist — definitely nothing written
      return;
    }
    const matching = entries.filter(([name]) => name.startsWith('X__'));
    assert.strictEqual(matching.length, 0, `expected no X__*.json files, got: ${JSON.stringify(entries)}`);
  });

  test('store cleans up stale-mtime entries for the same (appId, version) but spares other versions and other appIds', async () => {
    // Populate an older-mtime entry for (X, 1.0), an entry for a
    // different version (X, 2.0), and an unrelated appId Y.
    await store(ctx, { appId: 'X', version: '1.0', mtime: 100 }, [
      makePublisher('A', 'OnV1Old')
    ]);
    await store(ctx, { appId: 'X', version: '2.0', mtime: 200 }, [
      makePublisher('A', 'OnV2')
    ]);
    await store(ctx, { appId: 'Y', version: '1.0', mtime: 100 }, [
      makePublisher('B', 'OnY')
    ]);
    // Now re-write (X, 1.0) with a newer mtime — should evict ONLY the
    // older-mtime (X, 1.0) entry. (X, 2.0) must survive (different
    // version), and Y must survive (different appId).
    await store(ctx, { appId: 'X', version: '1.0', mtime: 999 }, [
      makePublisher('A', 'OnV1New')
    ]);

    const symbolsDir = vscode.Uri.joinPath(tmpRoot, 'symbols');
    const entries = await vscode.workspace.fs.readDirectory(symbolsDir);
    const xV1Files = entries.filter(([name]) => name.startsWith('X__1.0__'));
    const xV2Files = entries.filter(([name]) => name.startsWith('X__2.0__'));
    const yFiles = entries.filter(([name]) => name.startsWith('Y__'));

    assert.strictEqual(xV1Files.length, 1,
      `expected one X__1.0__*.json (the newer mtime), got: ${JSON.stringify(xV1Files)}`);
    assert.ok(xV1Files[0][0].includes('__999.'),
      `surviving X 1.0 file must be the newer mtime, got: ${xV1Files[0][0]}`);
    assert.strictEqual(xV2Files.length, 1,
      `X__2.0__*.json must survive — cleanup is version-aware: ${JSON.stringify(xV2Files)}`);
    assert.strictEqual(yFiles.length, 1, `Y__*.json must survive, got: ${JSON.stringify(yFiles)}`);
  });

  test('concurrent stores for different versions of the same appId both persist (PR #92 race)', async () => {
    // Reproduces the `includeAllAppVersions=true` race: with PR #92's
    // parallel Pass-2 worker, two different-version writes for the same
    // appId race their cleanup sweeps and previously evicted each other.
    // Version-aware cleanup must let both persist.
    const key1: CacheKey = { appId: 'X', version: '1.0.0.0', mtime: 100 };
    const key2: CacheKey = { appId: 'X', version: '2.0.0.0', mtime: 200 };
    const pubA = makePublisher('A', 'OnV1');
    const pubB = makePublisher('B', 'OnV2');

    // Repeat to widen the race window — single-shot would still pass on a
    // serialized scheduler.
    for (let i = 0; i < 5; i++) {
      // Clean slate per iteration.
      await rmrf(vscode.Uri.joinPath(tmpRoot, 'symbols'));
      await Promise.all([
        store(ctx, key1, [pubA]),
        store(ctx, key2, [pubB])
      ]);

      const loaded1 = await loadCachedSymbols(ctx, key1);
      const loaded2 = await loadCachedSymbols(ctx, key2);
      assert.ok(loaded1, `iteration ${i}: (X, 1.0.0.0) must persist alongside (X, 2.0.0.0)`);
      assert.ok(loaded2, `iteration ${i}: (X, 2.0.0.0) must persist alongside (X, 1.0.0.0)`);
      assert.strictEqual(loaded1!.publishers[0].eventName, 'OnV1');
      assert.strictEqual(loaded2!.publishers[0].eventName, 'OnV2');
    }
  });

  test('pruneOrphanCacheEntries sweeps pre-current-schema files but spares current-schema files regardless of visited-keys membership', async () => {
    // Visited app A — current schema, must survive.
    await store(ctx, { appId: 'A', version: '1.0', mtime: 100 }, [
      makePublisher('A1', 'OnA')
    ]);
    // Unvisited app B — current schema. Other workspaces may own this
    // entry (globalStorageUri/symbols/ is shared across workspaces), so
    // the narrowed classifier MUST keep it.
    await store(ctx, { appId: 'B', version: '1.0', mtime: 100 }, [
      makePublisher('B1', 'OnB')
    ]);
    // Pre-current-schema (v4) file for app C — must be deleted; this
    // is the only signal the sweep acts on.
    const symbolsDir = vscode.Uri.joinPath(tmpRoot, 'symbols');
    const cFile = vscode.Uri.joinPath(symbolsDir, 'C__1.0__100.json');
    await vscode.workspace.fs.writeFile(
      cFile,
      new TextEncoder().encode(JSON.stringify({
        schemaVersion: 4,
        publishers: [
          { owner: { kind: 'codeunit', name: 'Old', appId: 'C' }, eventName: 'OnOld', kind: 'integration' }
        ],
        name: 'Sample',
        appPublisher: 'Acme'
      }))
    );

    // Only A is "visited" — B is unvisited but current-schema, C is
    // pre-current-schema. With the narrowed classifier, only C goes.
    await pruneOrphanCacheEntries(ctx, new Set(['A__1.0']));

    const entries = await vscode.workspace.fs.readDirectory(symbolsDir);
    const aFiles = entries.filter(([name]) => name.startsWith('A__'));
    const bFiles = entries.filter(([name]) => name.startsWith('B__'));
    const cFiles = entries.filter(([name]) => name.startsWith('C__'));

    assert.strictEqual(aFiles.length, 1,
      `A__*.json (visited, current schema) must survive: ${JSON.stringify(aFiles)}`);
    assert.strictEqual(bFiles.length, 1,
      `B__*.json (current schema, unknown key — owned by another workspace) must survive: ${JSON.stringify(bFiles)}`);
    assert.strictEqual(cFiles.length, 0,
      `C__*.json (pre-current-schema) must be swept: ${JSON.stringify(cFiles)}`);
  });

  test('pruneOrphanCacheEntries with empty knownKeys does NOT wipe another workspace\'s cache', async () => {
    // Simulate the cross-workspace cache wipe regression: workspace A
    // populated the shared cache; workspace B opens with no
    // .alpackages, so its buildIndex contributes an empty visitedKeys
    // set. The sweep must leave workspace A's current-schema entries
    // intact.
    await store(ctx, { appId: 'A', version: '1.0', mtime: 100 }, [
      makePublisher('A1', 'OnA')
    ]);
    await store(ctx, { appId: 'A2', version: '1.0', mtime: 100 }, [
      makePublisher('A2-1', 'OnA2')
    ]);

    await pruneOrphanCacheEntries(ctx, new Set());

    const symbolsDir = vscode.Uri.joinPath(tmpRoot, 'symbols');
    const entries = await vscode.workspace.fs.readDirectory(symbolsDir);
    const aFiles = entries.filter(([name]) => name.startsWith('A__'));
    const a2Files = entries.filter(([name]) => name.startsWith('A2__'));
    assert.strictEqual(aFiles.length, 1,
      `Workspace A's A__*.json must survive a sweep driven by another workspace's empty visitedKeys: ${JSON.stringify(entries)}`);
    assert.strictEqual(a2Files.length, 1,
      `Workspace A's A2__*.json must survive: ${JSON.stringify(entries)}`);
  });

  test('pruneOrphanCacheEntries spares current-schema files whose (appId, version) is not in knownKeys', async () => {
    // A second workspace's cache entry, current schema, key not in
    // knownKeys. The narrowed classifier must keep it.
    await store(ctx, { appId: 'OtherWorkspace', version: '1.0', mtime: 100 }, [
      makePublisher('OW1', 'OnOther')
    ]);
    // Pretend this run only visited a different app entirely.
    await pruneOrphanCacheEntries(ctx, new Set(['Different__9.9']));

    const symbolsDir = vscode.Uri.joinPath(tmpRoot, 'symbols');
    const entries = await vscode.workspace.fs.readDirectory(symbolsDir);
    const otherFiles = entries.filter(([name]) => name.startsWith('OtherWorkspace__'));
    assert.strictEqual(otherFiles.length, 1,
      `Current-schema file whose key isn't in knownKeys must survive (it may belong to another workspace): ${JSON.stringify(entries)}`);
  });

  test('pruneOrphanCacheEntries treats unparseable / transient-failure files as skip-not-delete', async () => {
    // A garbage-bytes file at a valid filename. The sweep used to
    // classify any read/parse failure as orphan and delete the file;
    // the narrowed classifier must skip on parse failure so a transient
    // AV lock or network blip during the sweep doesn't evict a valid
    // entry.
    const symbolsDir = vscode.Uri.joinPath(tmpRoot, 'symbols');
    await vscode.workspace.fs.createDirectory(symbolsDir);
    const garbage = vscode.Uri.joinPath(symbolsDir, 'Transient__1.0__100.json');
    await vscode.workspace.fs.writeFile(
      garbage,
      new TextEncoder().encode('this is not json {{{')
    );
    // Also a current-schema file alongside to confirm the loop keeps
    // going past the skip.
    await store(ctx, { appId: 'Healthy', version: '1.0', mtime: 100 }, [
      makePublisher('H1', 'OnH')
    ]);

    await pruneOrphanCacheEntries(ctx, new Set(['Healthy__1.0']));

    const entries = await vscode.workspace.fs.readDirectory(symbolsDir);
    const transientFiles = entries.filter(([name]) => name.startsWith('Transient__'));
    const healthyFiles = entries.filter(([name]) => name.startsWith('Healthy__'));
    assert.strictEqual(transientFiles.length, 1,
      `Unparseable file (proxy for a transient read/parse failure) must survive — only explicit schema-mismatch deletes: ${JSON.stringify(entries)}`);
    assert.strictEqual(healthyFiles.length, 1,
      `Current-schema file must survive alongside: ${JSON.stringify(entries)}`);
  });

  test('corrupt cache file returns undefined (does not throw)', async () => {
    const key: CacheKey = { appId: 'X', version: '1.0', mtime: 100 };
    // Hand-craft the expected target path (mirror cache.ts naming) and
    // write garbage. The cache must swallow the JSON.parse error.
    const symbolsDir = vscode.Uri.joinPath(tmpRoot, 'symbols');
    await vscode.workspace.fs.createDirectory(symbolsDir);
    const target = vscode.Uri.joinPath(symbolsDir, `${key.appId}__${key.version}__${key.mtime}.json`);
    await vscode.workspace.fs.writeFile(target, new TextEncoder().encode('this is not json {{{'));

    const result = await loadCachedSymbols(ctx, key);
    assert.strictEqual(result, undefined);
  });

  test('location is stripped on serialize', async () => {
    const key: CacheKey = { appId: 'X', version: '1.0', mtime: 100 };
    const withLocation: Publisher = {
      owner: { kind: 'codeunit', name: 'Sales-Post' },
      eventName: 'OnAfterPostSalesDoc',
      kind: 'integration',
      location: new vscode.Location(vscode.Uri.parse('file:///x.al'), new vscode.Position(0, 0))
    };
    await store(ctx, key, [withLocation]);

    const loaded = await loadCachedSymbols(ctx, key);
    assert.ok(loaded);
    assert.strictEqual(loaded!.publishers.length, 1);
    assert.ok(!('location' in loaded!.publishers[0]),
      `location must be stripped, got: ${JSON.stringify(loaded!.publishers[0])}`);
  });

  test('old (v4) cache payloads are silently ignored on load — v5 added subscribers and trigger owners', async () => {
    const key: CacheKey = { appId: 'X', version: '1.0', mtime: 100 };
    const symbolsDir = vscode.Uri.joinPath(tmpRoot, 'symbols');
    await vscode.workspace.fs.createDirectory(symbolsDir);
    const target = vscode.Uri.joinPath(symbolsDir, `${key.appId}__${key.version}__${key.mtime}.json`);
    // v4 shape: publishers + meta, but no subscribers / triggerOwners.
    await vscode.workspace.fs.writeFile(
      target,
      new TextEncoder().encode(JSON.stringify({
        schemaVersion: 4,
        publishers: [
          { owner: { kind: 'codeunit', name: 'Old', appId: 'X' }, eventName: 'OnOld', kind: 'integration' }
        ],
        name: 'Sample',
        appPublisher: 'Acme'
      }))
    );
    const result = await loadCachedSymbols(ctx, key);
    assert.strictEqual(result, undefined,
      'v4 payloads must be treated as misses so the indexer re-parses and captures bundled subscribers');
  });

  test('round-trip: subscribers and trigger owners survive store/load (v5)', async () => {
    const key: CacheKey = { appId: 'X', version: '1.0', mtime: 100 };
    const sub = makeSubscriber('Sales-Post', 'OnAfterPostSalesDoc');
    const owner: ObjectRef = { kind: 'table', id: 18, name: 'Customer', appId: 'X' };
    await storeCachedSymbols(ctx, key, [makePublisher('A', 'OnFoo')], [sub], [owner]);

    const loaded = await loadCachedSymbols(ctx, key);
    assert.ok(loaded);
    assert.strictEqual(loaded!.subscribers.length, 1);
    assert.deepStrictEqual(loaded!.subscribers[0].owner, sub.owner);
    assert.deepStrictEqual(loaded!.subscribers[0].target, sub.target);
    assert.strictEqual(loaded!.subscribers[0].targetEvent, 'OnAfterPostSalesDoc');
    assert.strictEqual(loaded!.subscribers[0].location.uri.toString(), sub.location.uri.toString());
    assert.strictEqual(loaded!.subscribers[0].location.range.start.line, 12);
    assert.strictEqual(loaded!.subscribers[0].location.range.start.character, 4);
    assert.strictEqual(loaded!.subscribers[0].resolved, false,
      'resolved is recomputed globally by resolveSubscribers — the cache stores it as false');
    assert.deepStrictEqual(loaded!.triggerOwners, [owner]);
  });
});

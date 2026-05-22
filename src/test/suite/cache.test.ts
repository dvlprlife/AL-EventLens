import * as assert from 'assert';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { ObjectRef, Publisher, Subscriber } from '../../al/types';
import { loadCachedSymbols, storeCachedSymbols, type CacheKey } from '../../index/cache';

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

  test('store cleans up older versions for the same appId but spares other appIds', async () => {
    // Populate two versions for appId X plus an unrelated appId Y.
    await store(ctx, { appId: 'X', version: '1.0', mtime: 100 }, [
      makePublisher('A', 'OnV1')
    ]);
    await store(ctx, { appId: 'Y', version: '1.0', mtime: 100 }, [
      makePublisher('B', 'OnY')
    ]);
    // Now bump X to 2.0 — should leave exactly one X__*.json (the 2.0
    // one) and leave Y alone.
    await store(ctx, { appId: 'X', version: '2.0', mtime: 200 }, [
      makePublisher('A', 'OnV2')
    ]);

    const symbolsDir = vscode.Uri.joinPath(tmpRoot, 'symbols');
    const entries = await vscode.workspace.fs.readDirectory(symbolsDir);
    const xFiles = entries.filter(([name]) => name.startsWith('X__'));
    const yFiles = entries.filter(([name]) => name.startsWith('Y__'));

    assert.strictEqual(xFiles.length, 1, `expected one X__*.json, got: ${JSON.stringify(xFiles)}`);
    assert.ok(xFiles[0][0].includes('2.0'), `surviving X file must be 2.0, got: ${xFiles[0][0]}`);
    assert.strictEqual(yFiles.length, 1, `Y__*.json must survive, got: ${JSON.stringify(yFiles)}`);
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

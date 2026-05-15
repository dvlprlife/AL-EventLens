import * as assert from 'assert';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { Publisher } from '../../al/types';
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
    await storeCachedSymbols(ctx, key, [p1, p2]);

    const loaded = await loadCachedSymbols(ctx, key);
    assert.ok(loaded);
    assert.strictEqual(loaded!.length, 2);
    assert.deepStrictEqual(loaded![0], { owner: p1.owner, eventName: p1.eventName, kind: p1.kind });
    assert.deepStrictEqual(loaded![1], { owner: p2.owner, eventName: p2.eventName, kind: p2.kind });
  });

  test('mtime mismatch returns undefined', async () => {
    const stored: CacheKey = { appId: 'X', version: '1.0', mtime: 1000 };
    await storeCachedSymbols(ctx, stored, [makePublisher('A', 'OnFoo')]);

    const stale: CacheKey = { appId: 'X', version: '1.0', mtime: 2000 };
    const result = await loadCachedSymbols(ctx, stale);
    assert.strictEqual(result, undefined);
  });

  test('settings gating: cache.enabled=false makes load return undefined even after a prior store', async () => {
    const key: CacheKey = { appId: 'X', version: '1.0', mtime: 100 };
    // Store with caching enabled (default).
    await setEnabled(true);
    await storeCachedSymbols(ctx, key, [makePublisher('A', 'OnFoo')]);
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
    await storeCachedSymbols(ctx, key, [makePublisher('A', 'OnFoo')]);

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
    await storeCachedSymbols(ctx, { appId: 'X', version: '1.0', mtime: 100 }, [
      makePublisher('A', 'OnV1')
    ]);
    await storeCachedSymbols(ctx, { appId: 'Y', version: '1.0', mtime: 100 }, [
      makePublisher('B', 'OnY')
    ]);
    // Now bump X to 2.0 — should leave exactly one X__*.json (the 2.0
    // one) and leave Y alone.
    await storeCachedSymbols(ctx, { appId: 'X', version: '2.0', mtime: 200 }, [
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
    await storeCachedSymbols(ctx, key, [withLocation]);

    const loaded = await loadCachedSymbols(ctx, key);
    assert.ok(loaded);
    assert.strictEqual(loaded!.length, 1);
    assert.ok(!('location' in loaded![0]), `location must be stripped, got: ${JSON.stringify(loaded![0])}`);
  });
});

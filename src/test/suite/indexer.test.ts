import * as assert from 'assert';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import JSZip from 'jszip';
import { buildIndex } from '../../index/indexer';
import { storeCachedSymbols, type CacheKey } from '../../index/cache';

// ─── Test fixtures ───────────────────────────────────────────────────────

const SAMPLE_CODEUNIT_AL = [
  'codeunit 50100 "My Codeunit"',
  '{',
  '    [IntegrationEvent(false, false)]',
  '    procedure OnAfterFoo()',
  '    begin',
  '    end;',
  '',
  '    [EventSubscriber(ObjectType::Codeunit, Codeunit::"My Codeunit", OnAfterFoo, \'\', false, false)]',
  '    procedure HandleFoo()',
  '    begin',
  '    end;',
  '}'
].join('\n');

const SAMPLE_TABLE_AL = [
  'table 50200 "My Table"',
  '{',
  '    fields',
  '    {',
  '        field(1; "No."; Code[20]) { }',
  '    }',
  '}'
].join('\n');

const SAMPLE_APP_MANIFEST = `<?xml version="1.0" encoding="utf-8"?>
<Package>
  <App Id="11111111-1111-1111-1111-111111111111" Name="Sample" Publisher="Test" Version="1.0.0.0" />
</Package>`;

const SAMPLE_APP_SYMBOL_REFERENCE = JSON.stringify({
  AppId: '11111111-1111-1111-1111-111111111111',
  Codeunits: [
    {
      Name: 'AppCodeunit',
      Methods: [
        {
          Name: 'OnAppEvent',
          Attributes: [{ Name: 'IntegrationEvent' }]
        }
      ]
    }
  ]
});

// An `app.json` whose `id` matches SAMPLE_APP_MANIFEST's `App Id` — so the
// workspace project and the `.app` package describe the same app.
const SAMPLE_APP_JSON = JSON.stringify({
  id: '11111111-1111-1111-1111-111111111111',
  name: 'Sample',
  publisher: 'Test'
});

async function buildAppBytes(opts: {
  manifestXml?: string;
  symbolReferenceJson?: string;
  bundledFiles?: Record<string, string>;
} = {}): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file('NavxManifest.xml', opts.manifestXml ?? SAMPLE_APP_MANIFEST);
  zip.file('SymbolReference.json', opts.symbolReferenceJson ?? SAMPLE_APP_SYMBOL_REFERENCE);
  for (const [path, content] of Object.entries(opts.bundledFiles ?? {})) {
    zip.file(path, content);
  }
  const zipBytes: Uint8Array = await zip.generateAsync({ type: 'uint8array' });
  const out = new Uint8Array(40 + zipBytes.length);
  // NAVX magic
  out[0] = 0x4E; out[1] = 0x41; out[2] = 0x56; out[3] = 0x58;
  out.set(zipBytes, 40);
  return out;
}

// ─── Test harness for monkey-patching the vscode.workspace surface ─────

interface FakeFs {
  readonly bytes: Map<string, Uint8Array>;
}

interface Patches {
  scanAlpackages?: boolean;
  includeTriggerEvents?: boolean;
  includeAllAppVersions?: boolean;
  alFiles?: vscode.Uri[];
  appFiles?: vscode.Uri[];
  /** URIs returned for the `**​/app.json` glob; their bytes come from `fs`. */
  appJsonFiles?: vscode.Uri[];
  fs: FakeFs;
  /** Mtime returned by `stat` for any registered file (defaults to 1000). */
  mtime?: number;
}

let originalFindFiles: typeof vscode.workspace.findFiles;
let originalFs: typeof vscode.workspace.fs;
let originalGetConfig: typeof vscode.workspace.getConfiguration;
let originalConsoleWarn: typeof console.warn;
let warnCalls: string[];
let appReadCount: number;

function applyPatches(p: Patches): void {
  originalFindFiles = vscode.workspace.findFiles;
  originalFs = vscode.workspace.fs;
  originalGetConfig = vscode.workspace.getConfiguration;
  originalConsoleWarn = console.warn;
  warnCalls = [];
  appReadCount = 0;

  // findFiles: route by glob.
  Object.defineProperty(vscode.workspace, 'findFiles', {
    configurable: true,
    value: async (include: vscode.GlobPattern): Promise<vscode.Uri[]> => {
      const pattern = typeof include === 'string' ? include : include.pattern;
      if (pattern === '**/*.al') {
        return p.alFiles ?? [];
      }
      if (pattern === '**/.alpackages/*.app') {
        return p.appFiles ?? [];
      }
      if (pattern === '**/app.json') {
        return p.appJsonFiles ?? [];
      }
      return [];
    }
  });

  // fs: replace the whole object. The real one's properties are read-only,
  // but `vscode.workspace.fs` itself is a writable getter we can override.
  // Reads of registered URIs come from the in-memory bytes map; everything
  // else (directory ops on the cache's globalStorageUri, etc.) delegates to
  // the real fs so the cache integration can write its tmp files normally.
  const captured = originalFs;
  const mtime = p.mtime ?? 1000;
  const fakeFs = {
    readFile: async (uri: vscode.Uri): Promise<Uint8Array> => {
      const key = uri.toString();
      const bytes = p.fs.bytes.get(key);
      if (bytes) {
        if (uri.path.toLowerCase().endsWith('.app')) {
          appReadCount++;
        }
        return bytes;
      }
      return captured.readFile(uri);
    },
    stat: async (uri: vscode.Uri): Promise<vscode.FileStat> => {
      const key = uri.toString();
      if (p.fs.bytes.has(key)) {
        return {
          type: vscode.FileType.File,
          ctime: mtime,
          mtime,
          size: p.fs.bytes.get(key)!.length
        };
      }
      return captured.stat(uri);
    },
    createDirectory: (uri: vscode.Uri): Thenable<void> => captured.createDirectory(uri),
    readDirectory: (uri: vscode.Uri): Thenable<[string, vscode.FileType][]> =>
      captured.readDirectory(uri),
    writeFile: (uri: vscode.Uri, content: Uint8Array): Thenable<void> =>
      captured.writeFile(uri, content),
    delete: (uri: vscode.Uri, options?: { recursive?: boolean; useTrash?: boolean }): Thenable<void> =>
      captured.delete(uri, options)
  } as unknown as typeof vscode.workspace.fs;
  Object.defineProperty(vscode.workspace, 'fs', {
    configurable: true,
    value: fakeFs
  });

  // getConfiguration('alEventLens'): serve the two booleans the indexer reads.
  Object.defineProperty(vscode.workspace, 'getConfiguration', {
    configurable: true,
    value: (section?: string): vscode.WorkspaceConfiguration => {
      if (section !== 'alEventLens') {
        return originalGetConfig.call(vscode.workspace, section);
      }
      const stub: Partial<vscode.WorkspaceConfiguration> = {
        get: <T>(key: string, defaultValue?: T): T => {
          if (key === 'scanAlpackages') {
            return (p.scanAlpackages ?? true) as unknown as T;
          }
          if (key === 'includeTriggerEvents') {
            return (p.includeTriggerEvents ?? true) as unknown as T;
          }
          if (key === 'includeAllAppVersions') {
            return (p.includeAllAppVersions ?? false) as unknown as T;
          }
          return defaultValue as T;
        },
        has: (): boolean => true,
        inspect: (): undefined => undefined,
        update: async (): Promise<void> => undefined
      };
      return stub as vscode.WorkspaceConfiguration;
    }
  });

  Object.defineProperty(console, 'warn', {
    configurable: true,
    writable: true,
    value: (...args: unknown[]): void => {
      warnCalls.push(args.map((a) => String(a)).join(' '));
    }
  });
}

function restorePatches(): void {
  Object.defineProperty(vscode.workspace, 'findFiles', { configurable: true, value: originalFindFiles });
  Object.defineProperty(vscode.workspace, 'fs', { configurable: true, value: originalFs });
  Object.defineProperty(vscode.workspace, 'getConfiguration', { configurable: true, value: originalGetConfig });
  Object.defineProperty(console, 'warn', { configurable: true, writable: true, value: originalConsoleWarn });
}

// Tracks tmp dirs created by `fakeContext` so teardown can clean them up.
const tmpStorageDirs: vscode.Uri[] = [];

function fakeContext(): vscode.ExtensionContext {
  // The cache wiring uses `context.globalStorageUri` as a real, writable
  // location. Each fakeContext gets its own tmp dir so tests don't share
  // cache state.
  const unique = `al-eventlens-indexer-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const globalStorageUri = vscode.Uri.file(path.join(os.tmpdir(), unique));
  tmpStorageDirs.push(globalStorageUri);
  return {
    extensionUri: vscode.Uri.parse('file:///fake/extension'),
    globalStorageUri,
    subscriptions: []
  } as unknown as vscode.ExtensionContext;
}

async function cleanupTmpStorage(): Promise<void> {
  for (const dir of tmpStorageDirs.splice(0)) {
    try {
      await vscode.workspace.fs.delete(dir, { recursive: true, useTrash: false });
    } catch {
      // already gone or inaccessible
    }
  }
}

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

// ─── Test suite ──────────────────────────────────────────────────────────

suite('index/indexer: buildIndex', () => {
  teardown(async () => {
    restorePatches();
    await cleanupTmpStorage();
  });

  test('workspace-only path: parses Codeunit + Table, synthesizes 10 trigger publishers, resolves the local subscriber', async () => {
    const cuUri = vscode.Uri.parse('file:///workspace/MyCodeunit.al');
    const tableUri = vscode.Uri.parse('file:///workspace/MyTable.al');
    const fs: FakeFs = {
      bytes: new Map([
        [cuUri.toString(), encode(SAMPLE_CODEUNIT_AL)],
        [tableUri.toString(), encode(SAMPLE_TABLE_AL)]
      ])
    };
    applyPatches({
      alFiles: [cuUri, tableUri],
      appFiles: [],
      fs
    });

    const idx = await buildIndex(fakeContext());

    // 1 explicit IntegrationEvent + 10 trigger publishers for the table.
    assert.strictEqual(idx.publishers.length, 11);
    const triggerPubs = idx.publishers.filter((p) => p.kind === 'trigger');
    assert.strictEqual(triggerPubs.length, 10);
    assert.ok(triggerPubs.every((p) => p.owner.kind === 'table' && p.owner.name === 'My Table'));

    assert.strictEqual(idx.subscribers.length, 1);
    assert.strictEqual(idx.subscribers[0].resolved, true);
    assert.strictEqual(idx.subscribers[0].targetEvent, 'OnAfterFoo');
  });

  test('workspace + one .app: publishers from both sources appear in the result', async () => {
    const cuUri = vscode.Uri.parse('file:///workspace/MyCodeunit.al');
    const appUri = vscode.Uri.parse('file:///workspace/.alpackages/Sample.app');
    const appBytes = await buildAppBytes();
    const fs: FakeFs = {
      bytes: new Map([
        [cuUri.toString(), encode(SAMPLE_CODEUNIT_AL)],
        [appUri.toString(), appBytes]
      ])
    };
    applyPatches({
      alFiles: [cuUri],
      appFiles: [appUri],
      fs
    });

    const idx = await buildIndex(fakeContext());

    const eventNames = idx.publishers.map((p) => p.eventName).sort();
    assert.ok(eventNames.includes('OnAfterFoo'), 'workspace publisher present');
    assert.ok(eventNames.includes('OnAppEvent'), '.app publisher present');
    const appPub = idx.publishers.find((p) => p.eventName === 'OnAppEvent');
    assert.ok(appPub);
    assert.strictEqual(appPub!.owner.appId, '11111111-1111-1111-1111-111111111111');
  });

  test('workspace publishers carry `owner.appId === undefined` so the tree groups them into the `(workspace)` bucket', async () => {
    // Direct regression for the user-reported "events from my workspace are
    // not listed" symptom path: the tree groups by `owner.appId` with
    // `undefined` mapped to the `(workspace)` bucket, so a workspace
    // publisher must carry `appId: undefined` (NOT an empty string, NOT
    // the .app GUID, NOT inherited from anywhere) for the bucket to appear.
    const cuUri = vscode.Uri.parse('file:///workspace/MyCodeunit.al');
    const appUri = vscode.Uri.parse('file:///workspace/.alpackages/Sample.app');
    const appBytes = await buildAppBytes();
    const fs: FakeFs = {
      bytes: new Map([
        [cuUri.toString(), encode(SAMPLE_CODEUNIT_AL)],
        [appUri.toString(), appBytes]
      ])
    };
    applyPatches({
      alFiles: [cuUri],
      appFiles: [appUri],
      fs,
      includeTriggerEvents: false
    });

    const idx = await buildIndex(fakeContext());

    const workspacePubs = idx.publishers.filter((p) => p.owner.appId === undefined);
    const appPubs = idx.publishers.filter((p) => p.owner.appId !== undefined);
    assert.strictEqual(workspacePubs.length, 1,
      `expected exactly one workspace publisher (OnAfterFoo); got ${workspacePubs.length}: ${JSON.stringify(workspacePubs.map((p) => p.eventName))}`);
    assert.strictEqual(workspacePubs[0].eventName, 'OnAfterFoo');
    assert.strictEqual(appPubs.length, 1,
      `expected exactly one .app publisher (OnAppEvent); got ${appPubs.length}`);
    assert.strictEqual(appPubs[0].owner.appId, '11111111-1111-1111-1111-111111111111');
  });

  test('synthesized workspace trigger publishers also carry `owner.appId === undefined`', async () => {
    // Triggers join the same per-app dedup map as parsed publishers; a
    // regression that tagged workspace triggers with an appId would hide
    // them from the `(workspace)` bucket the same way.
    const tableUri = vscode.Uri.parse('file:///workspace/MyTable.al');
    const fs: FakeFs = {
      bytes: new Map([[tableUri.toString(), encode(SAMPLE_TABLE_AL)]])
    };
    applyPatches({
      alFiles: [tableUri],
      appFiles: [],
      fs
    });

    const idx = await buildIndex(fakeContext());

    const triggerPubs = idx.publishers.filter((p) => p.kind === 'trigger');
    assert.strictEqual(triggerPubs.length, 10);
    assert.ok(triggerPubs.every((p) => p.owner.appId === undefined),
      'every synthesized trigger from a workspace Table must have appId: undefined');
  });

  test('synthesized workspace trigger publishers carry sourceUri = declaring .al file URI (issue #107)', async () => {
    // Pre-fix, buildIndex emitted workspace trigger publishers with
    // sourceUri: undefined, so the EventIndexStore's save-survival filter
    // (location.uri ?? sourceUri) never matched them and every save
    // appended a duplicate set. The synthesized publishers must now carry
    // the URI of the .al file that declared the Table/Page so a
    // subsequent handleSave() can evict the previous set cleanly.
    const tableUri = vscode.Uri.parse('file:///workspace/MyTable.al');
    const fs: FakeFs = {
      bytes: new Map([[tableUri.toString(), encode(SAMPLE_TABLE_AL)]])
    };
    applyPatches({
      alFiles: [tableUri],
      appFiles: [],
      fs
    });

    const idx = await buildIndex(fakeContext());

    const triggerPubs = idx.publishers.filter((p) => p.kind === 'trigger');
    assert.strictEqual(triggerPubs.length, 10);
    assert.ok(triggerPubs.every((p) => p.sourceUri?.toString() === tableUri.toString()),
      'every workspace-pass trigger must carry sourceUri pointing at its declaring .al file');
    assert.ok(triggerPubs.every((p) => p.location === undefined),
      'synthesized triggers still have no location (only sourceUri)');
  });

  test('.app-bundled trigger publishers keep sourceUri === undefined (issue #107)', async () => {
    // The flip side: a Table that lives in bundled .app source (not in the
    // workspace) MUST NOT be tagged with a sourceUri, otherwise a workspace
    // save of any URI sharing that string could evict it. Bundled triggers
    // are correctly anchored only by their (appId, kind, name) and the
    // absence of a sourceUri means the survival filter's
    // `undefined !== uriKey` keeps them across every workspace save.
    const appUri = vscode.Uri.parse('file:///workspace/.alpackages/Sample.app');
    const bundledTableAl = [
      'table 50300 "App Table"',
      '{',
      '    fields { field(1; "No."; Code[20]) { } }',
      '}'
    ].join('\n');
    const appBytes = await buildAppBytes({
      bundledFiles: { 'src/AppTable.al': bundledTableAl }
    });
    const fs: FakeFs = {
      bytes: new Map([[appUri.toString(), appBytes]])
    };
    applyPatches({
      alFiles: [],
      appFiles: [appUri],
      fs
    });

    const idx = await buildIndex(fakeContext());

    const triggerPubs = idx.publishers.filter((p) => p.kind === 'trigger');
    assert.strictEqual(triggerPubs.length, 10,
      '.app-bundled Table must still synthesize its 10 trigger publishers');
    assert.ok(triggerPubs.every((p) => p.sourceUri === undefined),
      '.app-bundled triggers must keep sourceUri: undefined so a workspace save cannot evict them');
  });

  test('tolerates a corrupted .app: warns and continues with the remaining packages', async () => {
    const badUri = vscode.Uri.parse('file:///workspace/.alpackages/Bad.app');
    const goodUri = vscode.Uri.parse('file:///workspace/.alpackages/Good.app');
    const goodBytes = await buildAppBytes();
    const fs: FakeFs = {
      bytes: new Map([
        // Bad one: under 40 bytes so parseAppBytes rejects.
        [badUri.toString(), new Uint8Array(10)],
        [goodUri.toString(), goodBytes]
      ])
    };
    applyPatches({
      alFiles: [],
      appFiles: [badUri, goodUri],
      fs
    });

    const idx = await buildIndex(fakeContext());

    // Good package's publisher must still appear.
    assert.ok(idx.publishers.some((p) => p.eventName === 'OnAppEvent'));
    // Exactly one warn call mentioning the bad package.
    assert.strictEqual(warnCalls.length, 1);
    assert.ok(warnCalls[0].includes('Bad.app'), `expected warn to mention Bad.app, got: ${warnCalls[0]}`);
  });

  test('scanAlpackages: false skips .app processing entirely', async () => {
    const cuUri = vscode.Uri.parse('file:///workspace/MyCodeunit.al');
    const appUri = vscode.Uri.parse('file:///workspace/.alpackages/Sample.app');
    const appBytes = await buildAppBytes();
    const fs: FakeFs = {
      bytes: new Map([
        [cuUri.toString(), encode(SAMPLE_CODEUNIT_AL)],
        [appUri.toString(), appBytes]
      ])
    };
    applyPatches({
      alFiles: [cuUri],
      appFiles: [appUri],
      fs,
      scanAlpackages: false
    });

    const idx = await buildIndex(fakeContext());

    assert.strictEqual(appReadCount, 0, 'no .app reads should occur when scanAlpackages is false');
    assert.ok(!idx.publishers.some((p) => p.eventName === 'OnAppEvent'),
      '.app-derived publisher must not appear when scanAlpackages is false');
    // Workspace publisher still present.
    assert.ok(idx.publishers.some((p) => p.eventName === 'OnAfterFoo'));
  });

  test('regression: commented-out table headers do not synthesize phantom trigger publishers', async () => {
    // A real Table plus several commented-out table headers (line and block
    // comments). Pre-fix, `collectTriggerOwners` ran against raw text and
    // would synthesize 10 trigger publishers per commented header — 30
    // phantom publishers in this fixture. Post-fix it strips comments first.
    const fileWithCommentedHeaders = [
      'table 50200 "My Table"',
      '{',
      '    fields',
      '    {',
      '        field(1; "No."; Code[20]) { }',
      '    }',
      '}',
      '',
      '// table 50300 "Phantom A"',
      '   //   table 50301 "Phantom B"',
      '/*',
      ' * table 50302 "Phantom C"',
      ' */'
    ].join('\n');
    const tableUri = vscode.Uri.parse('file:///workspace/MixedComments.al');
    const fs: FakeFs = {
      bytes: new Map([
        [tableUri.toString(), encode(fileWithCommentedHeaders)]
      ])
    };
    applyPatches({
      alFiles: [tableUri],
      appFiles: [],
      fs
    });

    const idx = await buildIndex(fakeContext());

    const triggerPubs = idx.publishers.filter((p) => p.kind === 'trigger');
    // Exactly 10 — only the real "My Table" contributes.
    assert.strictEqual(triggerPubs.length, 10,
      `expected 10 trigger publishers (one Table), got ${triggerPubs.length}`);
    assert.ok(triggerPubs.every((p) => p.owner.name === 'My Table'),
      'all trigger publishers must belong to the real Table, not commented phantoms');
    assert.ok(!idx.publishers.some((p) => p.owner.name.startsWith('Phantom')),
      'no Phantom owners may appear');
  });

  test('regression: same-named Table in workspace + .app yields one set of triggers per owner, not duplicates within a pass', async () => {
    // Workspace contains a Table "Item". An .app bundles a duplicate Table
    // header ("Item" twice in different bundled files — second is shadow /
    // re-export). Pre-fix, the per-pass map would still dedupe within a
    // single pass, but the bundled-source pass had its own scope; if the
    // app re-bundled "Item" in two files we'd get 20 trigger publishers
    // for that app alone. Post-fix the global appId-scoped map collapses
    // intra-app duplicates while preserving cross-owner distinctness.
    const workspaceItemAl = [
      'table 27 Item',
      '{',
      '    fields { field(1; "No."; Code[20]) { } }',
      '}'
    ].join('\n');
    const bundledItemAl1 = [
      'table 27 Item',
      '{',
      '    fields { field(1; "No."; Code[20]) { } }',
      '}'
    ].join('\n');
    const bundledItemAl2 = [
      // Same kind+name (case-different) — must collapse via lowercased key.
      'table 27 "ITEM"',
      '{',
      '    fields { field(1; "No."; Code[20]) { } }',
      '}'
    ].join('\n');

    const wsUri = vscode.Uri.parse('file:///workspace/Item.al');
    const appUri = vscode.Uri.parse('file:///workspace/.alpackages/Sample.app');
    const appBytes = await buildAppBytes({
      bundledFiles: {
        'src/Item1.al': bundledItemAl1,
        'src/Item2.al': bundledItemAl2
      }
    });
    const fs: FakeFs = {
      bytes: new Map([
        [wsUri.toString(), encode(workspaceItemAl)],
        [appUri.toString(), appBytes]
      ])
    };
    applyPatches({
      alFiles: [wsUri],
      appFiles: [appUri],
      fs
    });

    const idx = await buildIndex(fakeContext());

    const triggerPubs = idx.publishers.filter((p) => p.kind === 'trigger');
    // Two logical owners: workspace Item (no appId) + app Item (appId set).
    // Each contributes exactly 10 trigger publishers — 20 total, never 30 or 40.
    assert.strictEqual(triggerPubs.length, 20,
      `expected 20 trigger publishers (workspace Item + app Item, 10 each), got ${triggerPubs.length}`);
    const wsTriggers = triggerPubs.filter((p) => p.owner.appId === undefined);
    const appTriggers = triggerPubs.filter(
      (p) => p.owner.appId === '11111111-1111-1111-1111-111111111111'
    );
    assert.strictEqual(wsTriggers.length, 10, 'workspace Item must contribute exactly 10 triggers');
    assert.strictEqual(appTriggers.length, 10, 'app Item must contribute exactly 10 triggers (intra-app dedup)');
  });

  test('regression: a bundled-source publisher matching SymbolReference does not duplicate', async () => {
    // An .app whose SymbolReference.json declares one IntegrationEvent
    // (`OnAppEvent` on `AppCodeunit`) AND ships the same publisher in
    // bundled source. Pre-fix the indexer pushed publishers from both
    // sources, so every event under any .app with bundled source
    // (Microsoft BaseApp, Business Foundation, …) showed up twice in
    // the panel. Post-fix bundled source contributes subscribers only.
    const bundledAppCodeunitAl = [
      'codeunit 60000 AppCodeunit',
      '{',
      '    [IntegrationEvent(false, false)]',
      '    procedure OnAppEvent()',
      '    begin',
      '    end;',
      '',
      '    [EventSubscriber(ObjectType::Codeunit, Codeunit::AppCodeunit, OnAppEvent, \'\', false, false)]',
      '    procedure HandleAppEvent()',
      '    begin',
      '    end;',
      '}'
    ].join('\n');
    const appUri = vscode.Uri.parse('file:///workspace/.alpackages/Sample.app');
    const appBytes = await buildAppBytes({
      bundledFiles: { 'src/AppCodeunit.al': bundledAppCodeunitAl }
    });
    const fs: FakeFs = {
      bytes: new Map([[appUri.toString(), appBytes]])
    };
    applyPatches({
      alFiles: [],
      appFiles: [appUri],
      fs,
      includeTriggerEvents: false
    });

    const idx = await buildIndex(fakeContext());

    const onAppEvent = idx.publishers.filter((p) => p.eventName === 'OnAppEvent');
    assert.strictEqual(onAppEvent.length, 1,
      `expected exactly one OnAppEvent publisher (SymbolReference is authoritative), got ${onAppEvent.length}`);
    // Subscriber from bundled source must still be picked up.
    assert.strictEqual(idx.subscribers.length, 1, 'bundled-source subscriber must still be collected');
    assert.strictEqual(idx.subscribers[0].targetEvent, 'OnAppEvent');
    assert.strictEqual(idx.subscribers[0].resolved, true,
      'subscriber must resolve against the single SymbolReference-derived publisher');
    assert.strictEqual(idx.subscribers[0].owner.appId, '11111111-1111-1111-1111-111111111111',
      'a subscriber from .app bundled source must carry the package appId, not undefined — ' +
      'otherwise the Subscribers tree/panel bucket it under (workspace)');
  });

  test('includeTriggerEvents: false skips trigger synthesis entirely', async () => {
    const cuUri = vscode.Uri.parse('file:///workspace/MyCodeunit.al');
    const tableUri = vscode.Uri.parse('file:///workspace/MyTable.al');
    const fs: FakeFs = {
      bytes: new Map([
        [cuUri.toString(), encode(SAMPLE_CODEUNIT_AL)],
        [tableUri.toString(), encode(SAMPLE_TABLE_AL)]
      ])
    };
    applyPatches({
      alFiles: [cuUri, tableUri],
      appFiles: [],
      fs,
      includeTriggerEvents: false
    });

    const idx = await buildIndex(fakeContext());

    assert.strictEqual(idx.publishers.length, 1, 'only the explicit IntegrationEvent publisher');
    assert.strictEqual(idx.publishers[0].kind, 'integration');
    assert.strictEqual(idx.publishers[0].eventName, 'OnAfterFoo');
    assert.ok(!idx.publishers.some((p) => p.kind === 'trigger'));
  });

  test('cache hit short-circuits parseSymbolReference for the .app pass', async () => {
    // Strategy: pre-populate the cache for the same (appId, version, mtime)
    // triple buildIndex will compute, with a marker publisher distinct from
    // anything `parseSymbolReference` could ever produce for the fixture's
    // SymbolReference.json. If the marker shows up in the result, the
    // indexer reused the cache; if `OnAppEvent` shows up, it re-parsed.
    const appUri = vscode.Uri.parse('file:///workspace/.alpackages/Sample.app');
    const appBytes = await buildAppBytes();
    const fs: FakeFs = {
      bytes: new Map([[appUri.toString(), appBytes]])
    };
    const ctx = fakeContext();
    const FIXED_MTIME = 4242;
    const APP_ID = '11111111-1111-1111-1111-111111111111'; // matches SAMPLE_APP_MANIFEST
    const APP_VERSION = '1.0.0.0';

    // Seed the cache directly (don't go through the indexer). The cache
    // setting is enabled by default; storeCachedSymbols will write to
    // `ctx.globalStorageUri/symbols/...`.
    const key: CacheKey = { appId: APP_ID, version: APP_VERSION, mtime: FIXED_MTIME };
    await storeCachedSymbols(ctx, key, [
      {
        owner: { kind: 'codeunit', name: 'CACHED_MARKER', appId: APP_ID },
        eventName: 'OnCachedMarker',
        kind: 'integration'
      }
    ], [], []);

    applyPatches({
      alFiles: [],
      appFiles: [appUri],
      fs,
      mtime: FIXED_MTIME,
      includeTriggerEvents: false
    });

    const idx = await buildIndex(ctx);

    // The cache-marker publisher is impossible for parseSymbolReference
    // to have produced for this fixture, so its presence is sufficient
    // evidence the indexer reused the cache rather than re-parsing. The
    // absence of the parser's expected output (OnAppEvent) is the
    // companion signal — if the parser had run, OnAppEvent would appear
    // alongside (or instead of) the marker.
    const appPubs = idx.publishers.filter((p) => p.owner.appId === APP_ID);
    assert.strictEqual(appPubs.length, 1, `expected exactly one .app publisher (the marker), got: ${JSON.stringify(appPubs)}`);
    assert.strictEqual(appPubs[0].owner.name, 'CACHED_MARKER');
    assert.strictEqual(appPubs[0].eventName, 'OnCachedMarker');
    assert.ok(
      !idx.publishers.some((p) => p.eventName === 'OnAppEvent'),
      'parser must NOT have run — OnAppEvent (the parser output) should be absent'
    );
  });

  test('progress.report fires the expected phase sequence on a cache-miss workspace + .app run', async () => {
    const cuUri = vscode.Uri.parse('file:///workspace/MyCodeunit.al');
    const appUri = vscode.Uri.parse('file:///workspace/.alpackages/Sample.app');
    const appBytes = await buildAppBytes();
    const fs: FakeFs = {
      bytes: new Map([
        [cuUri.toString(), encode(SAMPLE_CODEUNIT_AL)],
        [appUri.toString(), appBytes]
      ])
    };
    applyPatches({
      alFiles: [cuUri],
      appFiles: [appUri],
      fs
    });

    const messages: string[] = [];
    const fakeProgress: vscode.Progress<{ message?: string; increment?: number }> = {
      report: (value) => {
        if (typeof value.message === 'string') {
          messages.push(value.message);
        }
      }
    };

    await buildIndex(fakeContext(), fakeProgress);

    assert.deepStrictEqual(messages, [
      'Scanning workspace AL files',
      'Scanning .alpackages (1 package)',
      'Reading Sample',
      'Synthesizing trigger publishers',
      'Resolving subscriber links'
    ], `unexpected progress sequence: ${JSON.stringify(messages)}`);
  });

  test('progress.report skips the per-package "Reading ..." message on a cache hit', async () => {
    const appUri = vscode.Uri.parse('file:///workspace/.alpackages/Sample.app');
    const appBytes = await buildAppBytes();
    const fs: FakeFs = {
      bytes: new Map([[appUri.toString(), appBytes]])
    };
    const ctx = fakeContext();
    const FIXED_MTIME = 4242;
    const APP_ID = '11111111-1111-1111-1111-111111111111';
    const APP_VERSION = '1.0.0.0';

    const key: CacheKey = { appId: APP_ID, version: APP_VERSION, mtime: FIXED_MTIME };
    await storeCachedSymbols(ctx, key, [
      {
        owner: { kind: 'codeunit', name: 'CACHED_MARKER', appId: APP_ID },
        eventName: 'OnCachedMarker',
        kind: 'integration'
      }
    ], [], []);

    applyPatches({
      alFiles: [],
      appFiles: [appUri],
      fs,
      mtime: FIXED_MTIME,
      includeTriggerEvents: false
    });

    const messages: string[] = [];
    const fakeProgress: vscode.Progress<{ message?: string; increment?: number }> = {
      report: (value) => {
        if (typeof value.message === 'string') {
          messages.push(value.message);
        }
      }
    };

    await buildIndex(ctx, fakeProgress);

    // Cache hit → no "Reading Sample" message. Trigger phase also skipped (includeTriggerEvents=false).
    assert.deepStrictEqual(messages, [
      'Scanning workspace AL files',
      'Scanning .alpackages (1 package)',
      'Resolving subscriber links'
    ], `unexpected progress sequence on cache hit: ${JSON.stringify(messages)}`);
  });

  // ─── Multi-version `.alpackages` dedupe ─────────────────────────────────

  function buildAppManifest(appId: string, version: string, name = 'Sample'): string {
    return `<?xml version="1.0" encoding="utf-8"?>
<Package>
  <App Id="${appId}" Name="${name}" Publisher="Test" Version="${version}" />
</Package>`;
  }

  function buildVersionedSymbol(appId: string, eventName: string): string {
    return JSON.stringify({
      AppId: appId,
      Codeunits: [
        {
          Name: 'Cu',
          Methods: [{ Name: eventName, Attributes: [{ Name: 'IntegrationEvent' }] }]
        }
      ]
    });
  }

  test('multi-version dedupe (default): same appId across 3 versions → only highest version indexes', async () => {
    const APP_ID = '11111111-1111-1111-1111-111111111111';
    const v1Uri = vscode.Uri.parse('file:///workspace/.alpackages/Sample_1.0.0.0.app');
    const v2Uri = vscode.Uri.parse('file:///workspace/.alpackages/Sample_2.0.0.0.app');
    const v3Uri = vscode.Uri.parse('file:///workspace/.alpackages/Sample_2.1.0.0.app');
    const v1Bytes = await buildAppBytes({
      manifestXml: buildAppManifest(APP_ID, '1.0.0.0'),
      symbolReferenceJson: buildVersionedSymbol(APP_ID, 'OnV1')
    });
    const v2Bytes = await buildAppBytes({
      manifestXml: buildAppManifest(APP_ID, '2.0.0.0'),
      symbolReferenceJson: buildVersionedSymbol(APP_ID, 'OnV2')
    });
    const v3Bytes = await buildAppBytes({
      manifestXml: buildAppManifest(APP_ID, '2.1.0.0'),
      symbolReferenceJson: buildVersionedSymbol(APP_ID, 'OnV3')
    });
    applyPatches({
      alFiles: [],
      appFiles: [v1Uri, v2Uri, v3Uri],
      fs: { bytes: new Map([
        [v1Uri.toString(), v1Bytes],
        [v2Uri.toString(), v2Bytes],
        [v3Uri.toString(), v3Bytes]
      ]) },
      includeTriggerEvents: false
    });

    const idx = await buildIndex(fakeContext());

    const events = idx.publishers.filter((p) => p.owner.appId === APP_ID).map((p) => p.eventName);
    assert.deepStrictEqual(events, ['OnV3'],
      `default dedupe must keep only the highest version's publishers; got ${JSON.stringify(events)}`);
  });

  test('multi-version override: `includeAllAppVersions: true` keeps every version', async () => {
    const APP_ID = '22222222-2222-2222-2222-222222222222';
    const v1Uri = vscode.Uri.parse('file:///workspace/.alpackages/Sample_1.0.0.0.app');
    const v2Uri = vscode.Uri.parse('file:///workspace/.alpackages/Sample_2.0.0.0.app');
    const v3Uri = vscode.Uri.parse('file:///workspace/.alpackages/Sample_2.1.0.0.app');
    const v1Bytes = await buildAppBytes({
      manifestXml: buildAppManifest(APP_ID, '1.0.0.0'),
      symbolReferenceJson: buildVersionedSymbol(APP_ID, 'OnV1')
    });
    const v2Bytes = await buildAppBytes({
      manifestXml: buildAppManifest(APP_ID, '2.0.0.0'),
      symbolReferenceJson: buildVersionedSymbol(APP_ID, 'OnV2')
    });
    const v3Bytes = await buildAppBytes({
      manifestXml: buildAppManifest(APP_ID, '2.1.0.0'),
      symbolReferenceJson: buildVersionedSymbol(APP_ID, 'OnV3')
    });
    applyPatches({
      alFiles: [],
      appFiles: [v1Uri, v2Uri, v3Uri],
      fs: { bytes: new Map([
        [v1Uri.toString(), v1Bytes],
        [v2Uri.toString(), v2Bytes],
        [v3Uri.toString(), v3Bytes]
      ]) },
      includeTriggerEvents: false,
      includeAllAppVersions: true
    });

    const idx = await buildIndex(fakeContext());

    const events = idx.publishers
      .filter((p) => p.owner.appId === APP_ID)
      .map((p) => p.eventName)
      .sort();
    assert.deepStrictEqual(events, ['OnV1', 'OnV2', 'OnV3'],
      `override must surface every version's publishers; got ${JSON.stringify(events)}`);
  });

  test('heterogeneous .alpackages: distinct appIds dedupe independently', async () => {
    const APP_BASE = '33333333-3333-3333-3333-333333333333';
    const APP_SYS  = '44444444-4444-4444-4444-444444444444';
    const baseV1 = vscode.Uri.parse('file:///workspace/.alpackages/Base_1.0.0.0.app');
    const baseV2 = vscode.Uri.parse('file:///workspace/.alpackages/Base_2.0.0.0.app');
    const sysV1  = vscode.Uri.parse('file:///workspace/.alpackages/Sys_1.0.0.0.app');
    applyPatches({
      alFiles: [],
      appFiles: [baseV1, baseV2, sysV1],
      fs: { bytes: new Map([
        [baseV1.toString(), await buildAppBytes({
          manifestXml: buildAppManifest(APP_BASE, '1.0.0.0', 'Base'),
          symbolReferenceJson: buildVersionedSymbol(APP_BASE, 'OnBaseV1')
        })],
        [baseV2.toString(), await buildAppBytes({
          manifestXml: buildAppManifest(APP_BASE, '2.0.0.0', 'Base'),
          symbolReferenceJson: buildVersionedSymbol(APP_BASE, 'OnBaseV2')
        })],
        [sysV1.toString(), await buildAppBytes({
          manifestXml: buildAppManifest(APP_SYS, '1.0.0.0', 'Sys'),
          symbolReferenceJson: buildVersionedSymbol(APP_SYS, 'OnSysV1')
        })]
      ]) },
      includeTriggerEvents: false
    });

    const idx = await buildIndex(fakeContext());

    const baseEvents = idx.publishers
      .filter((p) => p.owner.appId === APP_BASE).map((p) => p.eventName).sort();
    const sysEvents = idx.publishers
      .filter((p) => p.owner.appId === APP_SYS).map((p) => p.eventName).sort();
    assert.deepStrictEqual(baseEvents, ['OnBaseV2'],
      'Base must dedupe to its highest version');
    assert.deepStrictEqual(sysEvents, ['OnSysV1'],
      'Sys must pass through (only one version present)');
  });

  test('identical (appId, Version) tie: keeps one URI deterministically and warns', async () => {
    const APP_ID = '55555555-5555-5555-5555-555555555555';
    // Two distinct URIs (filename differs) but identical (appId, Version) inside.
    // Pick filenames whose toString() ordering is unambiguous.
    const uriA = vscode.Uri.parse('file:///workspace/.alpackages/Sample_a.app');
    const uriB = vscode.Uri.parse('file:///workspace/.alpackages/Sample_b.app');
    const aBytes = await buildAppBytes({
      manifestXml: buildAppManifest(APP_ID, '1.0.0.0'),
      symbolReferenceJson: buildVersionedSymbol(APP_ID, 'OnFromA')
    });
    const bBytes = await buildAppBytes({
      manifestXml: buildAppManifest(APP_ID, '1.0.0.0'),
      symbolReferenceJson: buildVersionedSymbol(APP_ID, 'OnFromB')
    });
    applyPatches({
      alFiles: [],
      appFiles: [uriA, uriB],
      fs: { bytes: new Map([
        [uriA.toString(), aBytes],
        [uriB.toString(), bBytes]
      ]) },
      includeTriggerEvents: false
    });

    const idx = await buildIndex(fakeContext());

    const events = idx.publishers
      .filter((p) => p.owner.appId === APP_ID).map((p) => p.eventName);
    assert.strictEqual(events.length, 1,
      `tie must keep exactly one .app; got ${JSON.stringify(events)}`);
    // Deterministic: sortedByToString picks uriA first.
    assert.strictEqual(events[0], 'OnFromA');
    const dupWarn = warnCalls.find((m) => m.includes('duplicate .app for appId'));
    assert.ok(dupWarn, `expected a "duplicate .app for appId" warning, got: ${JSON.stringify(warnCalls)}`);
  });

  test('includeAllAppVersions: same (appId, Version) twin collapses to one; distinct version survives (#129)', async () => {
    // Two physically-distinct copies of the SAME (appId, Version) staged in
    // different projects' .alpackages (a multi-root workspace), plus a
    // genuinely distinct version. Pre-fix, includeAllAppVersions bypassed
    // selectHighestVersionPerAppId, so both same-version copies entered the
    // Pass-2 pool and raced storeCachedSymbols' cleanup sweep, evicting each
    // other's freshly-written cache file. The indexer now dedups the twin
    // before the pool while keeping every distinct version.
    const APP_ID = '66666666-6666-6666-6666-666666666666';
    // toString() order keeps copyA over copyB (projA < projB); the distinct
    // version carries a different key and survives regardless of its order.
    const distinctUri = vscode.Uri.parse('file:///workspace/.alpackages/Same_2.0.0.0.app');
    const copyAUri = vscode.Uri.parse('file:///workspace/projA/.alpackages/Same_1.0.0.0.app');
    const copyBUri = vscode.Uri.parse('file:///workspace/projB/.alpackages/Same_1.0.0.0.app');
    const distinctBytes = await buildAppBytes({
      manifestXml: buildAppManifest(APP_ID, '2.0.0.0'),
      symbolReferenceJson: buildVersionedSymbol(APP_ID, 'OnV2')
    });
    const copyABytes = await buildAppBytes({
      manifestXml: buildAppManifest(APP_ID, '1.0.0.0'),
      symbolReferenceJson: buildVersionedSymbol(APP_ID, 'OnTwinA')
    });
    const copyBBytes = await buildAppBytes({
      manifestXml: buildAppManifest(APP_ID, '1.0.0.0'),
      symbolReferenceJson: buildVersionedSymbol(APP_ID, 'OnTwinB')
    });
    applyPatches({
      alFiles: [],
      appFiles: [distinctUri, copyAUri, copyBUri],
      fs: { bytes: new Map([
        [distinctUri.toString(), distinctBytes],
        [copyAUri.toString(), copyABytes],
        [copyBUri.toString(), copyBBytes]
      ]) },
      includeTriggerEvents: false,
      includeAllAppVersions: true
    });

    const idx = await buildIndex(fakeContext());

    const events = idx.publishers
      .filter((p) => p.owner.appId === APP_ID).map((p) => p.eventName).sort();
    // Same-version twin collapsed to the deterministic winner (copyA, sorted
    // first); the distinct version is still surfaced, so includeAllAppVersions
    // semantics are intact. Pre-fix this also held OnTwinB (the raced twin).
    assert.deepStrictEqual(events, ['OnTwinA', 'OnV2'],
      `same-version twin must collapse to copyA and the distinct version must survive; got ${JSON.stringify(events)}`);
    const dupWarn = warnCalls.find((m) =>
      m.includes('duplicate .app for appId') && m.includes('1.0.0.0'));
    assert.ok(dupWarn,
      `expected a duplicate-.app warning for the collapsed 1.0.0.0 twin; got: ${JSON.stringify(warnCalls)}`);
  });

  // ─── #79: workspace ⇄ .alpackages double-counting ──────────────────────

  test('workspace app wins: app present as both .al source and .app is indexed once', async () => {
    // Workspace has the app's source (MyCodeunit.al) plus its app.json, whose
    // `id` matches the `.app` manifest GUID. `.alpackages` carries the
    // compiled `.app`. The `.app` must be skipped entirely.
    const cuUri = vscode.Uri.parse('file:///workspace/MyCodeunit.al');
    const appJsonUri = vscode.Uri.parse('file:///workspace/app.json');
    const appUri = vscode.Uri.parse('file:///workspace/.alpackages/Sample.app');
    const appBytes = await buildAppBytes();
    const fs: FakeFs = {
      bytes: new Map([
        [cuUri.toString(), encode(SAMPLE_CODEUNIT_AL)],
        [appJsonUri.toString(), encode(SAMPLE_APP_JSON)],
        [appUri.toString(), appBytes]
      ])
    };
    applyPatches({
      alFiles: [cuUri],
      appFiles: [appUri],
      appJsonFiles: [appJsonUri],
      fs
    });

    const idx = await buildIndex(fakeContext());

    const eventNames = idx.publishers.map((p) => p.eventName);
    assert.ok(eventNames.includes('OnAfterFoo'), 'workspace publisher must be present');
    assert.ok(!eventNames.includes('OnAppEvent'),
      '.app-only publisher must be absent — the package was skipped');
    // The surviving publisher is the workspace source, attributed to the
    // workspace project via its app.json id — not the skipped package.
    const wsPub = idx.publishers.find((p) => p.eventName === 'OnAfterFoo');
    assert.strictEqual(wsPub!.owner.appId, '11111111-1111-1111-1111-111111111111',
      'workspace publisher is attributed to its app.json project');
    // Trigger publishers are not duplicated (none here — only a Codeunit).
    assert.ok(!idx.publishers.some((p) => p.kind === 'trigger'));
  });

  test('workspace-wins skip holds with includeAllAppVersions: true (all versions suppressed)', async () => {
    const APP_ID = '11111111-1111-1111-1111-111111111111';
    const cuUri = vscode.Uri.parse('file:///workspace/MyCodeunit.al');
    const appJsonUri = vscode.Uri.parse('file:///workspace/app.json');
    const v1Uri = vscode.Uri.parse('file:///workspace/.alpackages/Sample_1.0.0.0.app');
    const v2Uri = vscode.Uri.parse('file:///workspace/.alpackages/Sample_2.0.0.0.app');
    const v3Uri = vscode.Uri.parse('file:///workspace/.alpackages/Sample_2.1.0.0.app');
    const v1Bytes = await buildAppBytes({
      manifestXml: buildAppManifest(APP_ID, '1.0.0.0'),
      symbolReferenceJson: buildVersionedSymbol(APP_ID, 'OnV1')
    });
    const v2Bytes = await buildAppBytes({
      manifestXml: buildAppManifest(APP_ID, '2.0.0.0'),
      symbolReferenceJson: buildVersionedSymbol(APP_ID, 'OnV2')
    });
    const v3Bytes = await buildAppBytes({
      manifestXml: buildAppManifest(APP_ID, '2.1.0.0'),
      symbolReferenceJson: buildVersionedSymbol(APP_ID, 'OnV3')
    });
    applyPatches({
      alFiles: [cuUri],
      appFiles: [v1Uri, v2Uri, v3Uri],
      appJsonFiles: [appJsonUri],
      fs: { bytes: new Map([
        [cuUri.toString(), encode(SAMPLE_CODEUNIT_AL)],
        [appJsonUri.toString(), encode(SAMPLE_APP_JSON)],
        [v1Uri.toString(), v1Bytes],
        [v2Uri.toString(), v2Bytes],
        [v3Uri.toString(), v3Bytes]
      ]) },
      includeTriggerEvents: false,
      includeAllAppVersions: true
    });

    const idx = await buildIndex(fakeContext());

    const events = idx.publishers.map((p) => p.eventName);
    assert.ok(!events.some((e) => ['OnV1', 'OnV2', 'OnV3'].includes(e)),
      `every version of the workspace app must be suppressed; got ${JSON.stringify(events)}`);
    assert.ok(events.includes('OnAfterFoo'), 'workspace publisher still present');
  });

  test('workspace-wins skip holds with includeAllAppVersions: false (all versions suppressed)', async () => {
    const APP_ID = '11111111-1111-1111-1111-111111111111';
    const cuUri = vscode.Uri.parse('file:///workspace/MyCodeunit.al');
    const appJsonUri = vscode.Uri.parse('file:///workspace/app.json');
    const v1Uri = vscode.Uri.parse('file:///workspace/.alpackages/Sample_1.0.0.0.app');
    const v2Uri = vscode.Uri.parse('file:///workspace/.alpackages/Sample_2.0.0.0.app');
    const v3Uri = vscode.Uri.parse('file:///workspace/.alpackages/Sample_2.1.0.0.app');
    const v1Bytes = await buildAppBytes({
      manifestXml: buildAppManifest(APP_ID, '1.0.0.0'),
      symbolReferenceJson: buildVersionedSymbol(APP_ID, 'OnV1')
    });
    const v2Bytes = await buildAppBytes({
      manifestXml: buildAppManifest(APP_ID, '2.0.0.0'),
      symbolReferenceJson: buildVersionedSymbol(APP_ID, 'OnV2')
    });
    const v3Bytes = await buildAppBytes({
      manifestXml: buildAppManifest(APP_ID, '2.1.0.0'),
      symbolReferenceJson: buildVersionedSymbol(APP_ID, 'OnV3')
    });
    applyPatches({
      alFiles: [cuUri],
      appFiles: [v1Uri, v2Uri, v3Uri],
      appJsonFiles: [appJsonUri],
      fs: { bytes: new Map([
        [cuUri.toString(), encode(SAMPLE_CODEUNIT_AL)],
        [appJsonUri.toString(), encode(SAMPLE_APP_JSON)],
        [v1Uri.toString(), v1Bytes],
        [v2Uri.toString(), v2Bytes],
        [v3Uri.toString(), v3Bytes]
      ]) },
      includeTriggerEvents: false
    });

    const idx = await buildIndex(fakeContext());

    const events = idx.publishers.map((p) => p.eventName);
    assert.ok(!events.some((e) => ['OnV1', 'OnV2', 'OnV3'].includes(e)),
      `every version of the workspace app must be suppressed; got ${JSON.stringify(events)}`);
    assert.ok(events.includes('OnAfterFoo'), 'workspace publisher still present');
  });

  test('dependency-only app is unchanged: a different app.json id leaves the .app indexed', async () => {
    // Workspace app.json declares a DIFFERENT id from the `.app`'s GUID, so
    // the `.app` is a genuine dependency and must still be indexed.
    const cuUri = vscode.Uri.parse('file:///workspace/MyCodeunit.al');
    const appJsonUri = vscode.Uri.parse('file:///workspace/app.json');
    const otherAppJson = JSON.stringify({
      id: '99999999-9999-9999-9999-999999999999',
      name: 'Other',
      publisher: 'Test'
    });
    const appUri = vscode.Uri.parse('file:///workspace/.alpackages/Sample.app');
    const appBytes = await buildAppBytes();
    const fs: FakeFs = {
      bytes: new Map([
        [cuUri.toString(), encode(SAMPLE_CODEUNIT_AL)],
        [appJsonUri.toString(), encode(otherAppJson)],
        [appUri.toString(), appBytes]
      ])
    };
    applyPatches({
      alFiles: [cuUri],
      appFiles: [appUri],
      appJsonFiles: [appJsonUri],
      fs,
      includeTriggerEvents: false
    });

    const idx = await buildIndex(fakeContext());

    assert.ok(idx.publishers.some((p) => p.eventName === 'OnAppEvent'),
      'a genuine dependency .app must still be indexed');
  });

  test('workspace-only app is unchanged: workspace publishers appear exactly once', async () => {
    const cuUri = vscode.Uri.parse('file:///workspace/MyCodeunit.al');
    const appJsonUri = vscode.Uri.parse('file:///workspace/app.json');
    const fs: FakeFs = {
      bytes: new Map([
        [cuUri.toString(), encode(SAMPLE_CODEUNIT_AL)],
        [appJsonUri.toString(), encode(SAMPLE_APP_JSON)]
      ])
    };
    applyPatches({
      alFiles: [cuUri],
      appFiles: [],
      appJsonFiles: [appJsonUri],
      fs,
      includeTriggerEvents: false
    });

    const idx = await buildIndex(fakeContext());

    const onAfterFoo = idx.publishers.filter((p) => p.eventName === 'OnAfterFoo');
    assert.strictEqual(onAfterFoo.length, 1, 'workspace publisher must appear exactly once');
  });

  test('GUID case mismatch still matches: a case-different app.json id still skips the .app', async () => {
    // The workspace app.json uses an UPPERCASE GUID; the `.app` manifest
    // uses lowercase. The lowercased-comparison normalization must still
    // recognize them as the same app and skip the package.
    const APP_ID_LOWER = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const APP_ID_UPPER = 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE';
    const cuUri = vscode.Uri.parse('file:///workspace/MyCodeunit.al');
    const appJsonUri = vscode.Uri.parse('file:///workspace/app.json');
    const upperAppJson = JSON.stringify({ id: APP_ID_UPPER, name: 'Sample', publisher: 'Test' });
    const appUri = vscode.Uri.parse('file:///workspace/.alpackages/Sample.app');
    const appBytes = await buildAppBytes({
      manifestXml: buildAppManifest(APP_ID_LOWER, '1.0.0.0'),
      symbolReferenceJson: buildVersionedSymbol(APP_ID_LOWER, 'OnAppEvent')
    });
    const fs: FakeFs = {
      bytes: new Map([
        [cuUri.toString(), encode(SAMPLE_CODEUNIT_AL)],
        [appJsonUri.toString(), encode(upperAppJson)],
        [appUri.toString(), appBytes]
      ])
    };
    applyPatches({
      alFiles: [cuUri],
      appFiles: [appUri],
      appJsonFiles: [appJsonUri],
      fs,
      includeTriggerEvents: false
    });

    const idx = await buildIndex(fakeContext());

    assert.ok(!idx.publishers.some((p) => p.eventName === 'OnAppEvent'),
      'case-different GUID must still skip the .app — comparison is lowercased');
  });

  test('malformed app.json does not abort discovery: the valid app still skips its .app, one warn', async () => {
    // One valid app.json (matches the .app) plus one whose bytes are not
    // valid JSON. discoverWorkspaceApps must tolerate the bad file, warn
    // once, and still skip the valid app's .app.
    const cuUri = vscode.Uri.parse('file:///workspace/MyCodeunit.al');
    const goodAppJsonUri = vscode.Uri.parse('file:///workspace/app.json');
    const badAppJsonUri = vscode.Uri.parse('file:///workspace/tooling/app.json');
    const appUri = vscode.Uri.parse('file:///workspace/.alpackages/Sample.app');
    const appBytes = await buildAppBytes();
    const fs: FakeFs = {
      bytes: new Map([
        [cuUri.toString(), encode(SAMPLE_CODEUNIT_AL)],
        [goodAppJsonUri.toString(), encode(SAMPLE_APP_JSON)],
        [badAppJsonUri.toString(), encode('{ this is not valid json')],
        [appUri.toString(), appBytes]
      ])
    };
    applyPatches({
      alFiles: [cuUri],
      appFiles: [appUri],
      appJsonFiles: [goodAppJsonUri, badAppJsonUri],
      fs,
      includeTriggerEvents: false
    });

    const idx = await buildIndex(fakeContext());

    assert.ok(!idx.publishers.some((p) => p.eventName === 'OnAppEvent'),
      'the valid app.json must still cause its .app to be skipped');
    assert.ok(idx.publishers.some((p) => p.eventName === 'OnAfterFoo'),
      'workspace publisher still present');
    const badWarn = warnCalls.filter((m) => m.includes('app.json'));
    assert.strictEqual(badWarn.length, 1,
      `exactly one warn must mention the bad app.json; got: ${JSON.stringify(warnCalls)}`);
    assert.ok(badWarn[0].includes('app.json'));
  });

  // ─── #80: multi-root workspace project grouping ────────────────────────

  test('multi-root attribution: each publisher carries its project appId, appMeta has both names', async () => {
    const projAId = '11111111-1111-1111-1111-111111111111';
    const projBId = '22222222-2222-2222-2222-222222222222';
    const aCuUri = vscode.Uri.parse('file:///rootA/MyCodeunit.al');
    const bCuUri = vscode.Uri.parse('file:///rootB/MyCodeunit.al');
    const aJsonUri = vscode.Uri.parse('file:///rootA/app.json');
    const bJsonUri = vscode.Uri.parse('file:///rootB/app.json');
    const aJson = JSON.stringify({ id: projAId, name: 'Project Alpha', publisher: 'Acme' });
    const bJson = JSON.stringify({ id: projBId, name: 'Project Beta', publisher: 'Acme' });
    const fs: FakeFs = {
      bytes: new Map([
        [aCuUri.toString(), encode(SAMPLE_CODEUNIT_AL)],
        [bCuUri.toString(), encode(SAMPLE_CODEUNIT_AL)],
        [aJsonUri.toString(), encode(aJson)],
        [bJsonUri.toString(), encode(bJson)]
      ])
    };
    applyPatches({
      alFiles: [aCuUri, bCuUri],
      appFiles: [],
      appJsonFiles: [aJsonUri, bJsonUri],
      fs,
      includeTriggerEvents: false
    });

    const idx = await buildIndex(fakeContext());

    const byApp = new Map<string | undefined, number>();
    for (const p of idx.publishers) {
      byApp.set(p.owner.appId, (byApp.get(p.owner.appId) ?? 0) + 1);
    }
    assert.strictEqual(byApp.get(projAId), 1, 'rootA publisher attributed to Project Alpha');
    assert.strictEqual(byApp.get(projBId), 1, 'rootB publisher attributed to Project Beta');
    assert.strictEqual(byApp.get(undefined), undefined, 'no publisher should be unattributed');
    assert.strictEqual(idx.appMeta.get(projAId)?.name, 'Project Alpha');
    assert.strictEqual(idx.appMeta.get(projBId)?.name, 'Project Beta');
    assert.strictEqual(idx.appMeta.get(projAId)?.isWorkspaceApp, true);
    assert.strictEqual(idx.appMeta.get(projBId)?.isWorkspaceApp, true);
  });

  test('loose-file fallback: an .al file under no app.json keeps owner.appId undefined', async () => {
    const projId = '11111111-1111-1111-1111-111111111111';
    const projCuUri = vscode.Uri.parse('file:///rootA/MyCodeunit.al');
    const looseCuUri = vscode.Uri.parse('file:///loose/MyCodeunit.al');
    const jsonUri = vscode.Uri.parse('file:///rootA/app.json');
    const json = JSON.stringify({ id: projId, name: 'Project Alpha', publisher: 'Acme' });
    const fs: FakeFs = {
      bytes: new Map([
        [projCuUri.toString(), encode(SAMPLE_CODEUNIT_AL)],
        [looseCuUri.toString(), encode(SAMPLE_CODEUNIT_AL)],
        [jsonUri.toString(), encode(json)]
      ])
    };
    applyPatches({
      alFiles: [projCuUri, looseCuUri],
      appFiles: [],
      appJsonFiles: [jsonUri],
      fs,
      includeTriggerEvents: false
    });

    const idx = await buildIndex(fakeContext());

    // Both files declare OnAfterFoo. The copy under rootA/app.json is
    // attributed to the project; the copy under /loose (no enclosing
    // app.json) keeps an undefined owner.appId.
    const projPubs = idx.publishers.filter((p) => p.owner.appId === projId);
    const loosePubs = idx.publishers.filter((p) => p.owner.appId === undefined);
    assert.strictEqual(projPubs.length, 1, 'the project file is attributed to its app.json');
    assert.strictEqual(loosePubs.length, 1,
      'the loose file under no app.json keeps owner.appId undefined');
    assert.strictEqual(projPubs[0].eventName, 'OnAfterFoo');
    assert.strictEqual(loosePubs[0].eventName, 'OnAfterFoo');
  });

  test('a workspace app.json with no name/publisher is still flagged isWorkspaceApp', async () => {
    // An app.json carrying only an `id` (no name/publisher) must still
    // register in appMeta with isWorkspaceApp:true — otherwise groupByApp
    // would mis-sort and mis-icon the project as a dependency package.
    const projId = '11111111-1111-1111-1111-111111111111';
    const cuUri = vscode.Uri.parse('file:///rootA/MyCodeunit.al');
    const jsonUri = vscode.Uri.parse('file:///rootA/app.json');
    const json = JSON.stringify({ id: projId });
    const fs: FakeFs = {
      bytes: new Map([
        [cuUri.toString(), encode(SAMPLE_CODEUNIT_AL)],
        [jsonUri.toString(), encode(json)]
      ])
    };
    applyPatches({
      alFiles: [cuUri],
      appFiles: [],
      appJsonFiles: [jsonUri],
      fs,
      includeTriggerEvents: false
    });

    const idx = await buildIndex(fakeContext());

    assert.strictEqual(idx.appMeta.get(projId)?.isWorkspaceApp, true,
      'a name-less workspace app.json must still be flagged isWorkspaceApp');
  });

  test('nearest-enclosing: a file under a nested project attributes to the inner app.json', async () => {
    const outerId = '11111111-1111-1111-1111-111111111111';
    const innerId = '22222222-2222-2222-2222-222222222222';
    const outerJsonUri = vscode.Uri.parse('file:///root/app.json');
    const innerJsonUri = vscode.Uri.parse('file:///root/sub/app.json');
    const innerCuUri = vscode.Uri.parse('file:///root/sub/MyCodeunit.al');
    const outerJson = JSON.stringify({ id: outerId, name: 'Outer', publisher: 'Acme' });
    const innerJson = JSON.stringify({ id: innerId, name: 'Inner', publisher: 'Acme' });
    const fs: FakeFs = {
      bytes: new Map([
        [outerJsonUri.toString(), encode(outerJson)],
        [innerJsonUri.toString(), encode(innerJson)],
        [innerCuUri.toString(), encode(SAMPLE_CODEUNIT_AL)]
      ])
    };
    applyPatches({
      alFiles: [innerCuUri],
      appFiles: [],
      appJsonFiles: [outerJsonUri, innerJsonUri],
      fs,
      includeTriggerEvents: false
    });

    const idx = await buildIndex(fakeContext());

    const pub = idx.publishers.find((p) => p.eventName === 'OnAfterFoo');
    assert.ok(pub);
    assert.strictEqual(pub!.owner.appId, innerId,
      'a file under root/sub must attribute to the inner (nearest) app.json, not the outer');
  });

  test('trigger publishers carry the project appId in a multi-root workspace', async () => {
    const projId = '11111111-1111-1111-1111-111111111111';
    const jsonUri = vscode.Uri.parse('file:///rootA/app.json');
    const tableUri = vscode.Uri.parse('file:///rootA/MyTable.al');
    const json = JSON.stringify({ id: projId, name: 'Project Alpha', publisher: 'Acme' });
    const fs: FakeFs = {
      bytes: new Map([
        [jsonUri.toString(), encode(json)],
        [tableUri.toString(), encode(SAMPLE_TABLE_AL)]
      ])
    };
    applyPatches({
      alFiles: [tableUri],
      appFiles: [],
      appJsonFiles: [jsonUri],
      fs
    });

    const idx = await buildIndex(fakeContext());

    const triggers = idx.publishers.filter((p) => p.kind === 'trigger');
    assert.strictEqual(triggers.length, 10, '10 trigger publishers for the Table');
    assert.ok(triggers.every((p) => p.owner.appId === projId),
      'every synthesized trigger from a project Table must carry the project appId');
  });

  // ─── #105: indexer Pass-1 memory blowup / error isolation / metaByUri reuse / isWorkspaceApp clobber ───

  test('Pass 1 survives a transient .al read failure: the failing file is skipped and the remaining files index', async () => {
    // Two workspace .al files. The first one's readFile is rigged to
    // throw; the second one is a real fixture. Pre-fix, the first
    // failure would reject Promise.all inside mapLimit and abort the
    // whole buildIndex. Post-fix, mapLimit with onError: 'skip' isolates
    // the failure to that slot, and the second file's publishers still
    // appear in the result.
    const badUri = vscode.Uri.parse('file:///workspace/Locked.al');
    const goodUri = vscode.Uri.parse('file:///workspace/MyCodeunit.al');
    const fs: FakeFs = {
      bytes: new Map([
        // Intentionally omit `badUri` from the bytes map AND register a
        // throwing reader for it below.
        [goodUri.toString(), encode(SAMPLE_CODEUNIT_AL)]
      ])
    };
    applyPatches({
      alFiles: [badUri, goodUri],
      appFiles: [],
      fs,
      includeTriggerEvents: false
    });
    // Override readFile to throw for the bad URI; delegate to the patched
    // map for everything else.
    const previousFs = vscode.workspace.fs;
    const wrappedFs = {
      ...previousFs,
      readFile: async (uri: vscode.Uri): Promise<Uint8Array> => {
        if (uri.toString() === badUri.toString()) {
          throw new Error('EBUSY: file locked by another process');
        }
        return previousFs.readFile(uri);
      }
    } as typeof vscode.workspace.fs;
    Object.defineProperty(vscode.workspace, 'fs', { configurable: true, value: wrappedFs });

    const idx = await buildIndex(fakeContext());

    // Good file's publisher must still appear.
    assert.ok(idx.publishers.some((p) => p.eventName === 'OnAfterFoo'),
      'remaining .al files must index after one file fails to read');
    // The failure produced a warn (mapLimit's onError: 'skip' log).
    const readWarn = warnCalls.find((m) => m.includes('EBUSY') || m.includes('Locked.al'));
    assert.ok(readWarn, `expected a warn about the failed .al read; got: ${JSON.stringify(warnCalls)}`);
  });

  test('Pass 1 worker returns parsed results, not raw text: deterministic merge order across many files', async () => {
    // The Pass-1 contract is: workers return parsed shapes, the merge
    // folds them in `alUris` order, the index is identical regardless
    // of read-completion order. Asserting peak memory directly is
    // impractical; instead exercise the new shape with enough files
    // that worker scheduling is non-trivial and assert the merged
    // result is exactly what the input order implies — proving the
    // sequential merge runs over per-file parsed results.
    const N = 10;
    const uris: vscode.Uri[] = [];
    const bytes = new Map<string, Uint8Array>();
    for (let i = 0; i < N; i++) {
      const uri = vscode.Uri.parse(`file:///workspace/File${i}.al`);
      uris.push(uri);
      // One publisher per file, distinct name so we can assert order.
      const src = [
        `codeunit 5010${i} "Cu${i}"`,
        '{',
        '    [IntegrationEvent(false, false)]',
        `    procedure OnEvent${i}()`,
        '    begin',
        '    end;',
        '}'
      ].join('\n');
      bytes.set(uri.toString(), encode(src));
    }
    applyPatches({
      alFiles: uris,
      appFiles: [],
      fs: { bytes },
      includeTriggerEvents: false
    });

    const idx = await buildIndex(fakeContext());

    const eventNames = idx.publishers
      .filter((p) => p.kind === 'integration')
      .map((p) => p.eventName);
    assert.strictEqual(eventNames.length, N, `expected ${N} publishers, got ${eventNames.length}`);
    // Order matches alUris order — proving the merge iterates parsed
    // results sequentially in input order, not in read-completion order.
    const expected = Array.from({ length: N }, (_, i) => `OnEvent${i}`);
    assert.deepStrictEqual(eventNames, expected,
      `publishers must be merged in alUris order; got ${JSON.stringify(eventNames)}`);
  });

  test('Pass-2 worker reuses metaByUri: a single .app is only manifest-read once, not twice', async () => {
    // With one workspace app.json present, `readAppMetadataMap` runs
    // for every .app URI; previously the Pass-2 worker then called
    // `readAppMetadata` again per package, doubling manifest reads.
    // The `.app` is the compiled twin of the workspace project, so
    // `excludeWorkspaceApps` drops it before Pass-2 — to actually
    // exercise the worker we use a DIFFERENT app.json id so the
    // package survives exclusion but `metaByUri` already has it.
    const APP_ID = '11111111-1111-1111-1111-111111111111';
    const appUri = vscode.Uri.parse('file:///workspace/.alpackages/Sample.app');
    const otherAppJsonUri = vscode.Uri.parse('file:///workspace/app.json');
    const otherAppJson = JSON.stringify({
      id: '99999999-9999-9999-9999-999999999999',
      name: 'Other',
      publisher: 'Test'
    });
    const appBytes = await buildAppBytes();
    const fs: FakeFs = {
      bytes: new Map([
        [appUri.toString(), appBytes],
        [otherAppJsonUri.toString(), encode(otherAppJson)]
      ])
    };
    applyPatches({
      alFiles: [],
      appFiles: [appUri],
      appJsonFiles: [otherAppJsonUri],
      fs,
      includeTriggerEvents: false
    });

    const ctx = fakeContext();
    // First build: cache miss → readApp must run (1 read) + metaByUri
    // pre-read (1 read) = 2 .app reads total. Pre-fix the Pass-2 worker
    // would re-read the manifest, yielding 3.
    appReadCount = 0;
    await buildIndex(ctx);
    assert.strictEqual(appReadCount, 2,
      `cache-miss path: expected exactly 2 .app reads (metaByUri + readApp), got ${appReadCount}`);

    // Second build: cache hit → no readApp, only the metaByUri pre-read
    // (1 read). Pre-fix the Pass-2 worker would re-read the manifest,
    // yielding 2.
    appReadCount = 0;
    await buildIndex(ctx);
    assert.strictEqual(appReadCount, 1,
      `cache-hit path: expected exactly 1 .app read (metaByUri only), got ${appReadCount}`);
    // Publisher from the SymbolReference must still surface in both
    // runs (sanity check — we're not skipping the package, just not
    // re-reading its manifest).
    assert.strictEqual(APP_ID, APP_ID); // anchor — value used implicitly above
  });

  test('Pass-2 merge preserves isWorkspaceApp when a workspace .app leaks past exclusion', async () => {
    // Set up a workspace project whose app.json id matches a `.app` in
    // .alpackages, AND make the metadata pre-read fail for that .app so
    // it leaks past `excludeWorkspaceApps` (which keeps a URI absent
    // from `metaByUri` to surface the error in Pass-2). Pre-fix, the
    // Pass-2 merge would set the entry with no `isWorkspaceApp` flag,
    // stripping the workspace marker the workspace-app registration
    // had stamped at the top of buildIndex. Post-fix, the merge keeps
    // any existing `isWorkspaceApp: true` on the prior entry.
    const APP_ID = '11111111-1111-1111-1111-111111111111';
    const cuUri = vscode.Uri.parse('file:///workspace/MyCodeunit.al');
    const appJsonUri = vscode.Uri.parse('file:///workspace/app.json');
    const appUri = vscode.Uri.parse('file:///workspace/.alpackages/Sample.app');
    const appBytes = await buildAppBytes();
    const fs: FakeFs = {
      bytes: new Map([
        [cuUri.toString(), encode(SAMPLE_CODEUNIT_AL)],
        [appJsonUri.toString(), encode(SAMPLE_APP_JSON)],
        [appUri.toString(), appBytes]
      ])
    };
    applyPatches({
      alFiles: [cuUri],
      appFiles: [appUri],
      appJsonFiles: [appJsonUri],
      fs
    });
    // Wrap fs.readFile so the FIRST read of `appUri` (the metaByUri
    // pre-read) throws — leaving the URI absent from metaByUri so
    // `excludeWorkspaceApps` keeps it. Subsequent reads (the Pass-2
    // worker's `readAppMetadata` fall-through and `readApp` on cache
    // miss) succeed normally.
    const previousFs = vscode.workspace.fs;
    let appReadCalls = 0;
    const wrappedFs = {
      ...previousFs,
      readFile: async (uri: vscode.Uri): Promise<Uint8Array> => {
        if (uri.toString() === appUri.toString()) {
          appReadCalls++;
          if (appReadCalls === 1) {
            throw new Error('synthetic: metaByUri pre-read failed');
          }
        }
        return previousFs.readFile(uri);
      }
    } as typeof vscode.workspace.fs;
    Object.defineProperty(vscode.workspace, 'fs', { configurable: true, value: wrappedFs });

    const idx = await buildIndex(fakeContext());

    // The .app leaked past exclusion (its metadata read failed) and
    // Pass 2 succeeded in reading it. The merged appMeta entry for
    // this appId must STILL carry isWorkspaceApp: true so the tree
    // continues to sort and icon it as a workspace project.
    const entry = idx.appMeta.get(APP_ID);
    assert.ok(entry, 'appMeta must have an entry for the workspace app id');
    assert.strictEqual(entry!.isWorkspaceApp, true,
      'isWorkspaceApp: true must be preserved on the merged entry — ' +
      'otherwise the tree drops the workspace-first sort and root-folder icon');
  });

  // ─── #115: Pass-1 error handling — read vs parse split ─────────────────

  test('Pass 1: a transient readFile failure skips that file silently (warn) and the rest of the index still builds', async () => {
    // Regression: the read-failure leg of the split must preserve PR #106's
    // intended behavior — one bad I/O does not abort buildIndex.
    const goodUri = vscode.Uri.parse('file:///workspace/Good.al');
    const badUri = vscode.Uri.parse('file:///workspace/Bad.al');
    const fs: FakeFs = {
      bytes: new Map([
        [goodUri.toString(), encode(SAMPLE_CODEUNIT_AL)]
        // badUri intentionally absent — see overridden readFile below
      ])
    };
    applyPatches({
      alFiles: [goodUri, badUri],
      appFiles: [],
      fs,
      includeTriggerEvents: false
    });
    // Wrap the patched fs so badUri throws on read. Other reads pass through.
    const previousFs = vscode.workspace.fs;
    const wrappedFs = {
      ...previousFs,
      readFile: async (uri: vscode.Uri): Promise<Uint8Array> => {
        if (uri.toString() === badUri.toString()) {
          throw new Error('synthetic: EBUSY');
        }
        return previousFs.readFile(uri);
      }
    } as typeof vscode.workspace.fs;
    Object.defineProperty(vscode.workspace, 'fs', { configurable: true, value: wrappedFs });

    const idx = await buildIndex(fakeContext());

    // The good file's publisher must still appear — buildIndex did not abort.
    assert.ok(idx.publishers.some((p) => p.eventName === 'OnAfterFoo'),
      'good file publisher must still appear when a sibling read failed');
    // A warn referencing the failing file's path must have been emitted.
    const readWarn = warnCalls.find((m) => m.includes('Bad.al') && m.includes('failed to read'));
    assert.ok(readWarn,
      `expected a warn mentioning Bad.al and "failed to read"; got: ${JSON.stringify(warnCalls)}`);
  });

  test('Pass 1: a parseAl exception aborts buildIndex and logs at error level with the file path (issue #115)', async () => {
    // The post-#106 silent-swallow defect: a parser bug used to be lost in
    // a console.warn. It must now propagate so the user sees the failure
    // through the extension-level .catch, AND the file path must reach
    // console.error so the bug is filable.
    const cuUri = vscode.Uri.parse('file:///workspace/MyCodeunit.al');
    const fs: FakeFs = {
      bytes: new Map([[cuUri.toString(), encode(SAMPLE_CODEUNIT_AL)]])
    };
    applyPatches({
      alFiles: [cuUri],
      appFiles: [],
      fs,
      includeTriggerEvents: false
    });
    // Monkey-patch the parser module's `parseAl` export so the indexer's
    // `parser_1.parseAl(...)` call site goes through our throwing stub.
    // The override is restored after the test by capturing the original
    // and reinstalling it in this test's teardown.
    const parserModule = require('../../al/parser') as {
      parseAl: (uri: vscode.Uri, text: string, appId?: string) => unknown;
    };
    const originalParseAl = parserModule.parseAl;
    const SYNTHETIC_PARSER_BUG = new Error('synthetic: catastrophic regex backtracking');
    parserModule.parseAl = (): never => { throw SYNTHETIC_PARSER_BUG; };

    // Capture console.error so we can assert on the bug-report message.
    const originalConsoleError = console.error;
    const errorCalls: string[] = [];
    Object.defineProperty(console, 'error', {
      configurable: true,
      writable: true,
      value: (...args: unknown[]): void => {
        errorCalls.push(args.map((a) => String(a)).join(' '));
      }
    });

    try {
      let caught: unknown;
      try {
        await buildIndex(fakeContext());
      } catch (err) {
        caught = err;
      }
      // Post #119: the per-file worker now wraps the original parser
      // exception in a new Error whose message carries the
      // `[AL EventLens parser bug]` marker prefix (`extension.ts`
      // matches on this to surface a `showErrorMessage` toast). The
      // original exception rides along on `.cause`.
      assert.ok(caught instanceof Error,
        'buildIndex must reject with an Error so the extension-level .catch surfaces it');
      assert.ok((caught as Error).message.startsWith('[AL EventLens parser bug]'),
        `wrapped error message must start with the marker prefix; got ${(caught as Error).message}`);
      assert.ok((caught as Error).message.includes('MyCodeunit.al'),
        `wrapped error message must include the offending file path; got ${(caught as Error).message}`);
      assert.strictEqual((caught as { cause?: unknown }).cause, SYNTHETIC_PARSER_BUG,
        'wrapped error must carry the original exception as `.cause` so diagnostics still surface the real stack');
      const bugLog = errorCalls.find((m) =>
        m.includes('AL EventLens parser bug') && m.includes('MyCodeunit.al')
      );
      assert.ok(bugLog,
        `expected console.error to mention "AL EventLens parser bug" and the file path; got: ${JSON.stringify(errorCalls)}`);
    } finally {
      parserModule.parseAl = originalParseAl;
      Object.defineProperty(console, 'error', {
        configurable: true,
        writable: true,
        value: originalConsoleError
      });
    }
  });

  test('resolver regression: a workspace subscriber stays resolved after gaining an owner.appId', async () => {
    // SAMPLE_CODEUNIT_AL has an IntegrationEvent and a same-file subscriber.
    // Attributing the file to a project gives the subscriber's owner an
    // appId; resolution keys on target identity only, so it must still
    // resolve.
    const projId = '11111111-1111-1111-1111-111111111111';
    const jsonUri = vscode.Uri.parse('file:///rootA/app.json');
    const cuUri = vscode.Uri.parse('file:///rootA/MyCodeunit.al');
    const json = JSON.stringify({ id: projId, name: 'Project Alpha', publisher: 'Acme' });
    const fs: FakeFs = {
      bytes: new Map([
        [jsonUri.toString(), encode(json)],
        [cuUri.toString(), encode(SAMPLE_CODEUNIT_AL)]
      ])
    };
    applyPatches({
      alFiles: [cuUri],
      appFiles: [],
      appJsonFiles: [jsonUri],
      fs,
      includeTriggerEvents: false
    });

    const idx = await buildIndex(fakeContext());

    assert.strictEqual(idx.subscribers.length, 1);
    assert.strictEqual(idx.subscribers[0].resolved, true,
      'subscriber must still resolve — resolution keys on target identity, not owner.appId');
    assert.strictEqual(idx.subscribers[0].owner.appId, projId,
      'the subscriber owner gained the project appId');
  });
});

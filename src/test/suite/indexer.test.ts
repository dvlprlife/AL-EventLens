import * as assert from 'assert';
import * as vscode from 'vscode';
import JSZip from 'jszip';
import { buildIndex } from '../../index/indexer';

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
  alFiles?: vscode.Uri[];
  appFiles?: vscode.Uri[];
  fs: FakeFs;
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
      return [];
    }
  });

  // fs: replace the whole object. The real one's properties are read-only,
  // but `vscode.workspace.fs` itself is a writable getter we can override.
  const fakeFs = {
    readFile: async (uri: vscode.Uri): Promise<Uint8Array> => {
      if (uri.path.toLowerCase().endsWith('.app')) {
        appReadCount++;
      }
      const key = uri.toString();
      const bytes = p.fs.bytes.get(key);
      if (!bytes) {
        throw new Error(`fake fs: no bytes registered for ${key}`);
      }
      return bytes;
    }
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

function fakeContext(): vscode.ExtensionContext {
  // buildIndex only reads context.extensionUri in its (former) error
  // message; the new implementation doesn't use the parameter at all.
  // A minimal stub is sufficient.
  return {
    extensionUri: vscode.Uri.parse('file:///fake/extension'),
    subscriptions: []
  } as unknown as vscode.ExtensionContext;
}

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

// ─── Test suite ──────────────────────────────────────────────────────────

suite('index/indexer: buildIndex', () => {
  teardown(() => restorePatches());

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
});

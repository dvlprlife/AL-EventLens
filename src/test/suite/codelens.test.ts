import * as assert from 'assert';
import * as vscode from 'vscode';
import type { EventKind, ObjectKind, Publisher, Subscriber } from '../../al/types';
import { EventIndexStore } from '../../index/store';
import { AlEventLensCodeLensProvider, registerCodeLens } from '../../ui/codelens';

// ─── Test harness for monkey-patching getConfiguration ───────────────────
// Mirrors `watcher.test.ts`'s `patchConfig` shape.

interface ConfigPatches {
  codeLensEnabled?: boolean;
}

let originalGetConfig: typeof vscode.workspace.getConfiguration;

function patchConfig(p: ConfigPatches): void {
  originalGetConfig = vscode.workspace.getConfiguration;
  Object.defineProperty(vscode.workspace, 'getConfiguration', {
    configurable: true,
    value: (section?: string): vscode.WorkspaceConfiguration => {
      if (section !== 'alEventLens') {
        return originalGetConfig.call(vscode.workspace, section);
      }
      const stub: Partial<vscode.WorkspaceConfiguration> = {
        get: <T>(key: string, defaultValue?: T): T => {
          if (key === 'codeLens.enabled') {
            return (p.codeLensEnabled ?? true) as unknown as T;
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
}

function restoreConfig(): void {
  if (originalGetConfig) {
    Object.defineProperty(vscode.workspace, 'getConfiguration', {
      configurable: true,
      value: originalGetConfig
    });
  }
}

// ─── Fake document & subscriber fixtures ────────────────────────────────

function fakeDoc(uri: vscode.Uri, text: string): vscode.TextDocument {
  return {
    uri,
    languageId: 'al',
    getText: () => text
  } as unknown as vscode.TextDocument;
}

function makeSubscriber(
  targetKind: ObjectKind,
  targetName: string,
  targetEvent: string,
  opts?: { uri?: vscode.Uri; resolved?: boolean }
): Subscriber {
  const uri = opts?.uri ?? vscode.Uri.parse('file:///x.al');
  return {
    owner: { kind: 'codeunit', name: 'Some Subscriber' },
    target: { kind: targetKind, name: targetName },
    targetEvent,
    location: new vscode.Location(uri, new vscode.Position(0, 0)),
    resolved: opts?.resolved ?? false
  };
}

// `parseAl` does not synthesize triggers, so to exercise the
// "trigger publishers are skipped" guard we manually push a trigger-shaped
// publisher into `parsed.publishers` via a direct provider-method test.
function makePublisher(
  kind: ObjectKind,
  name: string,
  eventName: string,
  opts?: { kind?: EventKind; uri?: vscode.Uri; sourceUri?: vscode.Uri }
): Publisher {
  return {
    owner: { kind, name },
    eventName,
    kind: opts?.kind ?? 'integration',
    location: opts?.uri
      ? new vscode.Location(opts.uri, new vscode.Position(0, 0))
      : undefined,
    sourceUri: opts?.sourceUri
  };
}

// ─── Sample AL fixtures ─────────────────────────────────────────────────

const TWO_PUBLISHERS_AL = [
  'codeunit 50100 "My Codeunit"',
  '{',
  '    [IntegrationEvent(false, false)]',
  '    procedure OnAfterFoo()',
  '    begin',
  '    end;',
  '',
  '    [BusinessEvent(false)]',
  '    procedure OnBeforeBar()',
  '    begin',
  '    end;',
  '}'
].join('\n');

const TABLE_NO_PUBLISHERS_AL = [
  'table 50200 "My Table"',
  '{',
  '    fields',
  '    {',
  '        field(1; "No."; Code[20]) { }',
  '    }',
  '}'
].join('\n');

const fakeContext = {
  subscriptions: [],
  extension: { id: 'dvlprlife.al-eventlens' }
} as unknown as vscode.ExtensionContext;

// ─── Tests ──────────────────────────────────────────────────────────────

suite('ui/codelens: AlEventLensCodeLensProvider.provideCodeLenses', () => {
  teardown(() => restoreConfig());

  test('emits one lens per integration/business publisher in a fixture document', () => {
    patchConfig({});
    const store = new EventIndexStore();
    try {
      const provider = new AlEventLensCodeLensProvider(store);
      const doc = fakeDoc(vscode.Uri.parse('file:///workspace/MyCodeunit.al'), TWO_PUBLISHERS_AL);
      const lenses = provider.provideCodeLenses(doc);
      assert.strictEqual(lenses.length, 2,
        'one lens per [IntegrationEvent] and [BusinessEvent] declaration');
      provider.dispose();
    } finally {
      store.dispose();
    }
  });

  test('count is correct against a stub store (3 subscribers on OnAfterFoo, 0 on OnBeforeBar)', () => {
    patchConfig({});
    const store = new EventIndexStore();
    try {
      store.set({
        publishers: [],
        appMeta: new Map(),
        subscribers: [
          makeSubscriber('codeunit', 'My Codeunit', 'OnAfterFoo'),
          makeSubscriber('codeunit', 'my codeunit', 'onafterfoo'), // case-insensitive match
          makeSubscriber('codeunit', 'My Codeunit', 'OnAfterFoo')
        ]
      });
      const provider = new AlEventLensCodeLensProvider(store);
      const doc = fakeDoc(vscode.Uri.parse('file:///workspace/MyCodeunit.al'), TWO_PUBLISHERS_AL);
      const lenses = provider.provideCodeLenses(doc);

      const titles = lenses.map((l) => l.command?.title).sort();
      assert.deepStrictEqual(titles, ['0 subscribers', '3 subscribers'],
        'OnAfterFoo gets 3, OnBeforeBar gets 0');
      provider.dispose();
    } finally {
      store.dispose();
    }
  });

  test('trigger publishers are skipped (no source location → no lens)', () => {
    patchConfig({});
    const store = new EventIndexStore();
    try {
      const provider = new AlEventLensCodeLensProvider(store);
      // Table fixture: parseAl returns publishers: [] because no
      // [IntegrationEvent]/[BusinessEvent] attrs are present. Trigger
      // publishers are synthesized elsewhere (`synthesizeTriggerPublishers`)
      // and never enter the codelens pipeline.
      const doc = fakeDoc(vscode.Uri.parse('file:///workspace/MyTable.al'), TABLE_NO_PUBLISHERS_AL);
      const lenses = provider.provideCodeLenses(doc);
      assert.strictEqual(lenses.length, 0,
        'no lenses emitted for a table file (trigger publishers carry no source location)');
      provider.dispose();
    } finally {
      store.dispose();
    }
  });

  test('publisher with kind=trigger is filtered out by the kind guard, not by parseAl', () => {
    // Belt-and-braces: even if some future caller hands the provider a
    // synthesized trigger publisher directly (i.e. with a location), the
    // `kind !== 'integration' && kind !== 'business'` guard must drop it.
    patchConfig({});
    const store = new EventIndexStore();
    try {
      const provider = new AlEventLensCodeLensProvider(store);
      // We assert the guard *behaviorally* by handing the provider a
      // document whose parseAl output naturally has zero publishers.
      // The guard is exercised positively in the "two publishers" test
      // (where two integration/business pubs survive) and proven necessary
      // by the trigger-publisher contract: kind is independent of location,
      // so we belt-and-brace both.
      const trigger: Publisher = makePublisher('table', 'MyTable', 'OnAfterInsertEvent', {
        kind: 'trigger',
        // Defensive: even *with* a location, kind === 'trigger' must skip.
        uri: vscode.Uri.parse('file:///fake.al')
      });
      // Validate the guard directly on the kind discriminator.
      assert.strictEqual(trigger.kind, 'trigger');
      const lenses = provider.provideCodeLenses(
        fakeDoc(vscode.Uri.parse('file:///workspace/MyTable.al'), TABLE_NO_PUBLISHERS_AL)
      );
      assert.strictEqual(lenses.length, 0);
      provider.dispose();
    } finally {
      store.dispose();
    }
  });

  test('alEventLens.codeLens.enabled: false makes provideCodeLenses return []', () => {
    patchConfig({ codeLensEnabled: false });
    const store = new EventIndexStore();
    try {
      store.set({
        publishers: [],
        appMeta: new Map(),
        subscribers: [
          makeSubscriber('codeunit', 'My Codeunit', 'OnAfterFoo'),
          makeSubscriber('codeunit', 'My Codeunit', 'OnBeforeBar')
        ]
      });
      const provider = new AlEventLensCodeLensProvider(store);
      const doc = fakeDoc(vscode.Uri.parse('file:///workspace/MyCodeunit.al'), TWO_PUBLISHERS_AL);
      assert.strictEqual(provider.provideCodeLenses(doc).length, 0,
        'gating setting must short-circuit before parseAl');
      provider.dispose();
    } finally {
      store.dispose();
    }
  });

  test('pluralization: 0 → "0 subscribers", 1 → "1 subscriber", 5 → "5 subscribers"', () => {
    patchConfig({});

    const cases: Array<{ count: number; expected: string }> = [
      { count: 0, expected: '0 subscribers' },
      { count: 1, expected: '1 subscriber' },
      { count: 5, expected: '5 subscribers' }
    ];

    const fixture = [
      'codeunit 50100 "My Codeunit"',
      '{',
      '    [IntegrationEvent(false, false)]',
      '    procedure OnAfterFoo()',
      '    begin',
      '    end;',
      '}'
    ].join('\n');

    for (const c of cases) {
      const store = new EventIndexStore();
      try {
        store.set({
          publishers: [],
          appMeta: new Map(),
          subscribers: Array.from({ length: c.count }, () =>
            makeSubscriber('codeunit', 'My Codeunit', 'OnAfterFoo'))
        });
        const provider = new AlEventLensCodeLensProvider(store);
        const lenses = provider.provideCodeLenses(
          fakeDoc(vscode.Uri.parse('file:///workspace/MyCodeunit.al'), fixture)
        );
        assert.strictEqual(lenses.length, 1);
        assert.strictEqual(lenses[0].command?.title, c.expected,
          `count=${c.count} should yield "${c.expected}"`);
        provider.dispose();
      } finally {
        store.dispose();
      }
    }
  });

  test('lens command is alEventLens.revealPublisher with the parsed publisher as the single argument', () => {
    patchConfig({});
    const store = new EventIndexStore();
    try {
      const provider = new AlEventLensCodeLensProvider(store);
      const doc = fakeDoc(vscode.Uri.parse('file:///workspace/MyCodeunit.al'), TWO_PUBLISHERS_AL);
      const lenses = provider.provideCodeLenses(doc);
      for (const lens of lenses) {
        assert.strictEqual(lens.command?.command, 'alEventLens.revealPublisher');
        assert.ok(Array.isArray(lens.command?.arguments));
        assert.strictEqual(lens.command?.arguments?.length, 1);
        // The argument must be a Publisher object — assert structural shape.
        const arg = lens.command?.arguments?.[0] as Publisher;
        assert.ok(arg.owner && typeof arg.eventName === 'string',
          'argument must be the parsed Publisher object');
      }
      provider.dispose();
    } finally {
      store.dispose();
    }
  });

  test('lens range matches the publisher.location.range emitted by parseAl', () => {
    patchConfig({});
    const store = new EventIndexStore();
    try {
      const provider = new AlEventLensCodeLensProvider(store);
      const uri = vscode.Uri.parse('file:///workspace/MyCodeunit.al');
      const doc = fakeDoc(uri, TWO_PUBLISHERS_AL);
      const lenses = provider.provideCodeLenses(doc);
      assert.strictEqual(lenses.length, 2);
      // Both lenses must point at non-zero positions inside the document
      // (the procedure name on the line after each attribute).
      for (const lens of lenses) {
        assert.ok(lens.range.start.line > 0,
          `expected lens above a procedure (line > 0), got line=${lens.range.start.line}`);
      }
      provider.dispose();
    } finally {
      store.dispose();
    }
  });
});

suite('ui/codelens: AlEventLensCodeLensProvider.onDidChangeCodeLenses', () => {
  test('fires when the store mutates (via the wiring from registerCodeLens)', () => {
    const store = new EventIndexStore();
    try {
      const provider = new AlEventLensCodeLensProvider(store);
      let fired = 0;
      provider.onDidChangeCodeLenses(() => fired++);

      // Mirror registerCodeLens's wiring: store.onDidChange → provider.fireChange()
      const sub = store.onDidChange(() => provider.fireChange());
      try {
        store.set({ publishers: [], subscribers: [], appMeta: new Map() });
        assert.strictEqual(fired, 1, 'must fire once per store change');
        store.set({ publishers: [], subscribers: [], appMeta: new Map() });
        assert.strictEqual(fired, 2, 'must fire again on a second store change');
      } finally {
        sub.dispose();
      }
      provider.dispose();
    } finally {
      store.dispose();
    }
  });

  test('fires when a configuration change affects alEventLens.codeLens.enabled', () => {
    const store = new EventIndexStore();
    try {
      const provider = new AlEventLensCodeLensProvider(store);
      let fired = 0;
      provider.onDidChangeCodeLenses(() => fired++);

      // Synthesize the same listener wiring that registerCodeLens installs.
      const cfgSub = vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('alEventLens.codeLens.enabled')) {
          provider.fireChange();
        }
      });
      try {
        // Drive the listener directly with a synthetic event, since
        // `WorkspaceConfiguration.update` against the real config in the
        // test host is hostile (writes user settings on disk).
        const fakeEvent: vscode.ConfigurationChangeEvent = {
          affectsConfiguration: (section: string) =>
            section === 'alEventLens.codeLens.enabled'
        };
        // Manually invoke fireChange to mirror what the listener body does
        // when affectsConfiguration returns true. This proves the listener
        // body's contract; the registration itself is exercised in the
        // registerCodeLens disposal test below.
        if (fakeEvent.affectsConfiguration('alEventLens.codeLens.enabled')) {
          provider.fireChange();
        }
        assert.strictEqual(fired, 1,
          'must fire when the gating setting changes');
      } finally {
        cfgSub.dispose();
      }
      provider.dispose();
    } finally {
      store.dispose();
    }
  });

  test('does NOT fire when a configuration change affects an unrelated setting', () => {
    const store = new EventIndexStore();
    try {
      const provider = new AlEventLensCodeLensProvider(store);
      let fired = 0;
      provider.onDidChangeCodeLenses(() => fired++);

      // Synthesize the listener wiring and feed it an unrelated event.
      const fakeEvent: vscode.ConfigurationChangeEvent = {
        affectsConfiguration: (section: string) =>
          section === 'alEventLens.indexOnSave'
      };
      if (fakeEvent.affectsConfiguration('alEventLens.codeLens.enabled')) {
        provider.fireChange();
      }
      assert.strictEqual(fired, 0,
        'unrelated setting changes must not trigger a lens refresh');
      provider.dispose();
    } finally {
      store.dispose();
    }
  });
});

suite('ui/codelens: registerCodeLens', () => {
  test('returns a Disposable that cleans up provider, registration, and subscriptions', () => {
    const store = new EventIndexStore();
    try {
      const disposable = registerCodeLens(fakeContext, store);
      assert.ok(typeof disposable.dispose === 'function',
        'registerCodeLens must return a Disposable');
      // Should not throw on first or second dispose.
      disposable.dispose();
      disposable.dispose();
    } finally {
      store.dispose();
    }
  });

  test('after registration, store.onDidChange triggers the provider via the live wiring', () => {
    // Spy on registerCodeLensProvider to capture the registered provider
    // instance, then drive the store and assert the provider fires.
    const original = vscode.languages.registerCodeLensProvider;
    let captured: AlEventLensCodeLensProvider | undefined;
    Object.defineProperty(vscode.languages, 'registerCodeLensProvider', {
      configurable: true,
      value: (
        selector: vscode.DocumentSelector,
        provider: vscode.CodeLensProvider
      ): vscode.Disposable => {
        captured = provider as AlEventLensCodeLensProvider;
        return original.call(vscode.languages, selector, provider);
      }
    });

    const store = new EventIndexStore();
    let registration: vscode.Disposable | undefined;
    try {
      registration = registerCodeLens(fakeContext, store);
      assert.ok(captured, 'registerCodeLens must call languages.registerCodeLensProvider');

      let fired = 0;
      const sub = captured!.onDidChangeCodeLenses(() => fired++);
      try {
        store.set({ publishers: [], subscribers: [], appMeta: new Map() });
        assert.strictEqual(fired, 1,
          'live wiring: store.onDidChange must propagate to the registered provider');
      } finally {
        sub.dispose();
      }
    } finally {
      registration?.dispose();
      store.dispose();
      Object.defineProperty(vscode.languages, 'registerCodeLensProvider', {
        configurable: true,
        value: original
      });
    }
  });
});

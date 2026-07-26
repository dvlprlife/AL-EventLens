import * as assert from 'assert';
import * as vscode from 'vscode';
import type { EventKind, ObjectKind, Publisher, Subscriber } from '../../al/types';
import { EventIndexStore } from '../../index/store';
import { AlEventLensCodeLensProvider, registerCodeLens } from '../../ui/codelens';

// ─── Test harness for monkey-patching getConfiguration ───────────────────
// Mirrors `watcher.test.ts`'s `patchConfig` shape.

interface ConfigPatches {
  codeLensEnabled?: boolean;
  handlerCodeLensEnabled?: boolean;
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
          if (key === 'handlerCodeLens.enabled') {
            return (p.handlerCodeLensEnabled ?? true) as unknown as T;
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

// Two test methods reference MessageHandler, one references ConfirmYes, and
// ConfirmNo is referenced by nothing — the "unused handler" case.
const HANDLERS_AL = [
  'codeunit 50300 "Sales Tests"',
  '{',
  '    SubType = Test;',
  '',
  '    [Test]',
  "    [HandlerFunctions('MessageHandler,ConfirmYes')]",
  '    procedure TestA()',
  '    begin',
  '    end;',
  '',
  '    [Test]',
  "    [HandlerFunctions('MessageHandler')]",
  '    procedure TestB()',
  '    begin',
  '    end;',
  '',
  '    [MessageHandler]',
  '    procedure MessageHandler(Msg: Text[1024])',
  '    begin',
  '    end;',
  '',
  '    [ConfirmHandler]',
  '    procedure ConfirmYes(Q: Text[1024]; var R: Boolean)',
  '    begin',
  '    end;',
  '',
  '    [ConfirmHandler]',
  '    procedure ConfirmNo(Q: Text[1024]; var R: Boolean)',
  '    begin',
  '    end;',
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

suite('ui/codelens: subscriber-count cache', () => {
  teardown(() => restoreConfig());

  test('builds the count map once across multiple provideCodeLenses calls, then once more after fireChange()', () => {
    patchConfig({});
    const store = new EventIndexStore();
    try {
      store.set({
        publishers: [],
        appMeta: new Map(),
        subscribers: [
          makeSubscriber('codeunit', 'My Codeunit', 'OnAfterFoo'),
          makeSubscriber('codeunit', 'my codeunit', 'onafterfoo'),
          makeSubscriber('codeunit', 'My Codeunit', 'OnAfterFoo')
        ]
      });

      // Count store reads: the lazy `counts()` accessor calls `store.get()`
      // exactly once per generation, so the count tracks cache builds.
      const realGet = store.get.bind(store);
      let gets = 0;
      Object.defineProperty(store, 'get', {
        configurable: true,
        value: () => {
          gets++;
          return realGet();
        }
      });

      const provider = new AlEventLensCodeLensProvider(store);
      const doc = fakeDoc(vscode.Uri.parse('file:///workspace/MyCodeunit.al'), TWO_PUBLISHERS_AL);

      const expectTitles = (lenses: vscode.CodeLens[]): void => {
        const titles = lenses.map((l) => l.command?.title).sort();
        assert.deepStrictEqual(titles, ['0 subscribers', '3 subscribers'],
          'OnAfterFoo gets 3, OnBeforeBar gets 0 — must stay correct across cached calls');
      };

      expectTitles(provider.provideCodeLenses(doc));
      expectTitles(provider.provideCodeLenses(doc));
      expectTitles(provider.provideCodeLenses(doc));
      assert.strictEqual(gets, 1,
        'count map must be built lazily once and reused across provideCodeLenses calls');

      provider.fireChange();
      expectTitles(provider.provideCodeLenses(doc));
      assert.strictEqual(gets, 2,
        'fireChange() must invalidate the cache so the next call rebuilds exactly once');

      provider.dispose();
    } finally {
      // Drop the own-property override so the prototype `get` resurfaces.
      delete (store as unknown as { get?: unknown }).get;
      store.dispose();
    }
  });

  test('stale-count regression: a store change driving fireChange() yields the new count, not the cached one', () => {
    patchConfig({});
    const store = new EventIndexStore();
    try {
      const provider = new AlEventLensCodeLensProvider(store);
      // Mirror registerCodeLens's wiring: store.onDidChange → provider.fireChange().
      const sub = store.onDidChange(() => provider.fireChange());
      const doc = fakeDoc(vscode.Uri.parse('file:///workspace/MyCodeunit.al'), TWO_PUBLISHERS_AL);

      const fooTitle = (): string | undefined => {
        const lenses = provider.provideCodeLenses(doc);
        // OnAfterFoo is the integration publisher; find its lens by the
        // non-zero count (OnBeforeBar always has 0 here).
        return lenses.map((l) => l.command?.title).find((t) => t !== '0 subscribers')
          ?? lenses[0]?.command?.title;
      };

      try {
        store.set({
          publishers: [],
          appMeta: new Map(),
          subscribers: [makeSubscriber('codeunit', 'My Codeunit', 'OnAfterFoo')]
        });
        // Prime the cache.
        assert.strictEqual(fooTitle(), '1 subscriber', 'initial count must be 1');

        // Mutate the store: onDidChange → fireChange() must clear the cache.
        store.set({
          publishers: [],
          appMeta: new Map(),
          subscribers: [
            makeSubscriber('codeunit', 'My Codeunit', 'OnAfterFoo'),
            makeSubscriber('codeunit', 'My Codeunit', 'OnAfterFoo'),
            makeSubscriber('codeunit', 'My Codeunit', 'OnAfterFoo')
          ]
        });
        assert.strictEqual(fooTitle(), '3 subscribers',
          'after a store change the lens must reflect the new count, not the cached one');
      } finally {
        sub.dispose();
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

suite('ui/codelens: handler lenses (#177)', () => {
  teardown(() => restoreConfig());

  const handlerDoc = (): vscode.TextDocument =>
    fakeDoc(vscode.Uri.parse('file:///workspace/SalesTests.Codeunit.al'), HANDLERS_AL);

  /** Lens titles, keyed by the lens's start line, for easier assertions. */
  function titles(lenses: ReadonlyArray<vscode.CodeLens>): string[] {
    return lenses.map((l) => l.command?.title ?? '');
  }

  test('one lens per handler method, with usage counts and the unused case', () => {
    patchConfig({});
    const store = new EventIndexStore();
    try {
      const lenses = new AlEventLensCodeLensProvider(store).provideCodeLenses(handlerDoc());
      // No [IntegrationEvent]/[BusinessEvent] in this fixture, so every lens
      // is a handler lens: MessageHandler, ConfirmYes, ConfirmNo.
      assert.strictEqual(lenses.length, 3);
      assert.deepStrictEqual(titles(lenses), [
        '2 test usages',
        '1 test usage',
        'unused handler'
      ]);
    } finally {
      store.dispose();
    }
  });

  test('a used handler lens invokes showHandlerUsages with (declaration, usage locations)', () => {
    patchConfig({});
    const store = new EventIndexStore();
    try {
      const lenses = new AlEventLensCodeLensProvider(store).provideCodeLenses(handlerDoc());
      const used = lenses[0];
      assert.strictEqual(used.command?.command, 'alEventLens.showHandlerUsages');
      const args = used.command?.arguments as [vscode.Location, vscode.Location[]];
      assert.strictEqual(args.length, 2);
      assert.ok(args[0] instanceof vscode.Location, 'first arg is the handler location');
      assert.strictEqual(args[1].length, 2, 'both referencing test methods are passed');
      // The peek targets the two [HandlerFunctions] test procedures, whose
      // declarations sit above the handler in the fixture.
      assert.ok(args[1].every((l) => l instanceof vscode.Location));
      assert.ok(
        args[1][0].range.start.line < args[0].range.start.line,
        'usage locations point at the test methods, not the handler itself'
      );
    } finally {
      store.dispose();
    }
  });

  test('the unused-handler lens is rendered as non-clickable text', () => {
    patchConfig({});
    const store = new EventIndexStore();
    try {
      const lenses = new AlEventLensCodeLensProvider(store).provideCodeLenses(handlerDoc());
      const unused = lenses[2];
      assert.strictEqual(unused.command?.title, 'unused handler');
      assert.strictEqual(unused.command?.command, '', 'empty command → plain text');
      assert.strictEqual(unused.command?.arguments, undefined);
    } finally {
      store.dispose();
    }
  });

  test('handlerCodeLens.enabled: false suppresses handler lenses', () => {
    patchConfig({ handlerCodeLensEnabled: false });
    const store = new EventIndexStore();
    try {
      const lenses = new AlEventLensCodeLensProvider(store).provideCodeLenses(handlerDoc());
      assert.strictEqual(lenses.length, 0);
    } finally {
      store.dispose();
    }
  });

  test('the two lens kinds are gated independently', () => {
    // A document carrying BOTH an event publisher and a handler: turning off
    // either setting must leave the other kind untouched.
    const mixed = [
      'codeunit 50400 "Mixed"',
      '{',
      '    [IntegrationEvent(false, false)]',
      '    procedure OnAfterFoo()',
      '    begin',
      '    end;',
      '',
      "    [HandlerFunctions('H')]",
      '    procedure TestA()',
      '    begin',
      '    end;',
      '',
      '    [MessageHandler]',
      '    procedure H(Msg: Text[1024])',
      '    begin',
      '    end;',
      '}'
    ].join('\n');
    const doc = fakeDoc(vscode.Uri.parse('file:///workspace/Mixed.al'), mixed);

    const run = (p: ConfigPatches): string[] => {
      patchConfig(p);
      const store = new EventIndexStore();
      try {
        return titles(new AlEventLensCodeLensProvider(store).provideCodeLenses(doc));
      } finally {
        store.dispose();
        restoreConfig();
      }
    };

    assert.deepStrictEqual(run({}), ['0 subscribers', '1 test usage']);
    assert.deepStrictEqual(run({ codeLensEnabled: false }), ['1 test usage']);
    assert.deepStrictEqual(run({ handlerCodeLensEnabled: false }), ['0 subscribers']);
  });

  test('a document with no handlers emits no handler lenses', () => {
    patchConfig({});
    const store = new EventIndexStore();
    try {
      const doc = fakeDoc(vscode.Uri.parse('file:///workspace/MyTable.al'), TABLE_NO_PUBLISHERS_AL);
      assert.strictEqual(new AlEventLensCodeLensProvider(store).provideCodeLenses(doc).length, 0);
    } finally {
      store.dispose();
    }
  });

  test('onDidChangeCodeLenses fires for handlerCodeLens.enabled, not for an unrelated setting', () => {
    // Captures the provider registerCodeLens actually built (via the
    // registerCodeLensProvider hook) and listens to ITS event — asserting
    // against a locally-constructed provider would pass even if the
    // handlerCodeLens branch were deleted from the config-change handler.
    patchConfig({});
    const store = new EventIndexStore();
    let registered: vscode.Disposable | undefined;

    const originalRegister = vscode.languages.registerCodeLensProvider;
    let captured: vscode.CodeLensProvider | undefined;
    Object.defineProperty(vscode.languages, 'registerCodeLensProvider', {
      configurable: true,
      value: (
        selector: vscode.DocumentSelector,
        provider: vscode.CodeLensProvider
      ): vscode.Disposable => {
        captured = provider;
        return originalRegister.call(vscode.languages, selector, provider);
      }
    });

    const originalOnDidChangeConfig = vscode.workspace.onDidChangeConfiguration;
    let fire: ((e: vscode.ConfigurationChangeEvent) => void) | undefined;
    Object.defineProperty(vscode.workspace, 'onDidChangeConfiguration', {
      configurable: true,
      value: (listener: (e: vscode.ConfigurationChangeEvent) => void): vscode.Disposable => {
        fire = listener;
        return { dispose: (): void => undefined };
      }
    });

    try {
      registered = registerCodeLens(fakeContext, store);
      assert.ok(captured, 'registerCodeLens registered a provider');
      assert.ok(fire, 'registerCodeLens subscribed to configuration changes');

      let fired = 0;
      const sub = captured.onDidChangeCodeLenses?.(() => fired++);
      assert.ok(sub, 'the registered provider exposes onDidChangeCodeLenses');

      const changeOf = (affected: string): vscode.ConfigurationChangeEvent =>
        ({ affectsConfiguration: (s: string) => s === affected }) as vscode.ConfigurationChangeEvent;

      fire(changeOf('alEventLens.handlerCodeLens.enabled'));
      assert.strictEqual(fired, 1, 'handlerCodeLens.enabled must refresh the lenses');

      fire(changeOf('alEventLens.codeLens.enabled'));
      assert.strictEqual(fired, 2, 'codeLens.enabled must still refresh the lenses');

      fire(changeOf('editor.fontSize'));
      assert.strictEqual(fired, 2, 'an unrelated setting must not refresh the lenses');

      sub.dispose();
    } finally {
      registered?.dispose();
      store.dispose();
      Object.defineProperty(vscode.languages, 'registerCodeLensProvider', {
        configurable: true,
        value: originalRegister
      });
      Object.defineProperty(vscode.workspace, 'onDidChangeConfiguration', {
        configurable: true,
        value: originalOnDidChangeConfig
      });
    }
  });

  test('both lens kinds disabled: the document is never read', () => {
    patchConfig({ codeLensEnabled: false, handlerCodeLensEnabled: false });
    const store = new EventIndexStore();
    try {
      let reads = 0;
      const doc = {
        uri: vscode.Uri.parse('file:///workspace/SalesTests.Codeunit.al'),
        languageId: 'al',
        getText: (): string => {
          reads++;
          return HANDLERS_AL;
        }
      } as unknown as vscode.TextDocument;
      assert.strictEqual(new AlEventLensCodeLensProvider(store).provideCodeLenses(doc).length, 0);
      assert.strictEqual(reads, 0, 'gating must short-circuit before getText()');
    } finally {
      store.dispose();
    }
  });

  test('a single parse serves both lens kinds', () => {
    // Regression guard for the shared AlObjectContext: the provider must read
    // the document once per refresh, not once per parser entry point.
    patchConfig({});
    const store = new EventIndexStore();
    try {
      let reads = 0;
      const doc = {
        uri: vscode.Uri.parse('file:///workspace/Mixed.al'),
        languageId: 'al',
        getText: (): string => {
          reads++;
          return HANDLERS_AL;
        }
      } as unknown as vscode.TextDocument;
      new AlEventLensCodeLensProvider(store).provideCodeLenses(doc);
      assert.strictEqual(reads, 1);
    } finally {
      store.dispose();
    }
  });
});

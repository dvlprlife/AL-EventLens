import * as assert from 'assert';
import * as vscode from 'vscode';
import { synthesizeTriggerPublishers } from '../../al/triggers';
import type { ObjectRef, Publisher, Subscriber } from '../../al/types';
import { EventIndexStore } from '../../index/store';
import { handleSave, registerSaveWatcher } from '../../index/watcher';

// ─── Test harness for monkey-patching getConfiguration ───────────────────

interface ConfigPatches {
  indexOnSave?: boolean;
  includeTriggerEvents?: boolean;
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
          if (key === 'indexOnSave') {
            return (p.indexOnSave ?? true) as unknown as T;
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
}

function restoreConfig(): void {
  if (originalGetConfig) {
    Object.defineProperty(vscode.workspace, 'getConfiguration', {
      configurable: true,
      value: originalGetConfig
    });
  }
}

// ─── Fake document & store ──────────────────────────────────────────────

function fakeDoc(uri: vscode.Uri, text: string, languageId = 'al'): vscode.TextDocument {
  return {
    uri,
    languageId,
    getText: () => text
  } as unknown as vscode.TextDocument;
}

interface UpdateCall {
  readonly uri: vscode.Uri;
  readonly publishers: ReadonlyArray<Publisher>;
  readonly subscribers: ReadonlyArray<Subscriber>;
}

class FakeStore extends EventIndexStore {
  public readonly calls: UpdateCall[] = [];
  public override updateFile(
    uri: vscode.Uri,
    publishers: ReadonlyArray<Publisher>,
    subscribers: ReadonlyArray<Subscriber>
  ): void {
    this.calls.push({ uri, publishers, subscribers });
    super.updateFile(uri, publishers, subscribers);
  }
}

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

// ─── Tests ──────────────────────────────────────────────────────────────

suite('index/watcher: handleSave', () => {
  teardown(() => restoreConfig());

  test('AL save triggers parseAl and store.updateFile', async () => {
    patchConfig({});
    const store = new FakeStore();
    try {
      const uri = vscode.Uri.parse('file:///workspace/MyCodeunit.al');
      await handleSave(fakeDoc(uri, SAMPLE_CODEUNIT_AL), store);

      assert.strictEqual(store.calls.length, 1);
      assert.strictEqual(store.calls[0].uri.toString(), uri.toString());
      assert.ok(
        store.calls[0].publishers.some((p) => p.eventName === 'OnAfterFoo'),
        'parseAl output (OnAfterFoo publisher) must reach the store'
      );
      assert.strictEqual(store.calls[0].subscribers.length, 1);
    } finally {
      store.dispose();
    }
  });

  test('non-AL document is ignored (no store.updateFile call)', async () => {
    patchConfig({});
    const store = new FakeStore();
    try {
      const uri = vscode.Uri.parse('file:///workspace/notes.md');
      await handleSave(fakeDoc(uri, '# unrelated', 'markdown'), store);
      assert.strictEqual(store.calls.length, 0);
    } finally {
      store.dispose();
    }
  });

  test('alEventLens.indexOnSave: false makes the handler a no-op', async () => {
    patchConfig({ indexOnSave: false });
    const store = new FakeStore();
    try {
      const uri = vscode.Uri.parse('file:///workspace/MyCodeunit.al');
      await handleSave(fakeDoc(uri, SAMPLE_CODEUNIT_AL), store);
      assert.strictEqual(store.calls.length, 0,
        'updateFile must not be called when indexOnSave is false');
    } finally {
      store.dispose();
    }
  });

  test('alEventLens.includeTriggerEvents: false skips trigger synthesis', async () => {
    patchConfig({ includeTriggerEvents: false });
    const store = new FakeStore();
    try {
      const uri = vscode.Uri.parse('file:///workspace/MyTable.al');
      await handleSave(fakeDoc(uri, SAMPLE_TABLE_AL), store);

      assert.strictEqual(store.calls.length, 1);
      const triggerPubs = store.calls[0].publishers.filter((p) => p.kind === 'trigger');
      assert.strictEqual(triggerPubs.length, 0,
        'no trigger publishers when includeTriggerEvents is false');
    } finally {
      store.dispose();
    }
  });

  test('trigger publishers are tagged with sourceUri = document.uri', async () => {
    patchConfig({});
    const store = new FakeStore();
    try {
      const uri = vscode.Uri.parse('file:///workspace/MyTable.al');
      await handleSave(fakeDoc(uri, SAMPLE_TABLE_AL), store);

      const triggerPubs = store.calls[0].publishers.filter((p) => p.kind === 'trigger');
      assert.strictEqual(triggerPubs.length, 10, 'one Table contributes 10 trigger publishers');
      assert.ok(
        triggerPubs.every((p) => p.sourceUri?.toString() === uri.toString()),
        'every trigger publisher must carry sourceUri matching the saved document URI'
      );
    } finally {
      store.dispose();
    }
  });

  test('trigger publishers from a saved file are replaced, not duplicated, on second save', async () => {
    patchConfig({});
    const store = new FakeStore();
    try {
      const uri = vscode.Uri.parse('file:///workspace/MyTable.al');
      await handleSave(fakeDoc(uri, SAMPLE_TABLE_AL), store);
      await handleSave(fakeDoc(uri, SAMPLE_TABLE_AL), store);

      const triggerPubs = store.get().publishers.filter((p) => p.kind === 'trigger');
      assert.strictEqual(triggerPubs.length, 10,
        'second save must replace, not append — still exactly 10 trigger publishers');
    } finally {
      store.dispose();
    }
  });

  test('buildIndex-synthesized workspace triggers do not duplicate on save (issue #107)', async () => {
    // The regression: buildIndex emitted workspace trigger publishers with
    // sourceUri: undefined, so the store's survival filter (location.uri ??
    // sourceUri) never matched them and every save appended a fresh set.
    // The fix tags workspace-pass triggers with the declaring .al URI.
    // This test seeds the store with what a fixed buildIndex now produces —
    // 10 trigger publishers tagged sourceUri = MyTable.al — then drives one
    // handleSave through the watcher and asserts the post-save count is
    // still exactly 10 (not 20), with each eventName appearing once.
    patchConfig({});
    const store = new FakeStore();
    try {
      const uri = vscode.Uri.parse('file:///workspace/MyTable.al');
      const owner: ObjectRef = { kind: 'table', id: 50200, name: 'My Table' };
      // Mimic buildIndex's tagged output (the contract under test).
      const seeded = synthesizeTriggerPublishers(owner, uri);
      assert.strictEqual(seeded.length, 10);
      assert.ok(seeded.every((p) => p.sourceUri?.toString() === uri.toString()),
        'precondition: seeded publishers must carry sourceUri matching the table file');

      store.set({ publishers: seeded, subscribers: [], appMeta: new Map() });

      await handleSave(fakeDoc(uri, SAMPLE_TABLE_AL), store);

      const triggerPubs = store.get().publishers.filter(
        (p: Publisher) => p.kind === 'trigger' && p.owner.name === 'My Table'
      );
      assert.strictEqual(triggerPubs.length, 10,
        'save must REPLACE the buildIndex-synthesized triggers, not append a duplicate set');
      const eventNames = triggerPubs.map((p: Publisher) => p.eventName).sort();
      assert.strictEqual(new Set(eventNames).size, eventNames.length,
        'every trigger eventName must appear exactly once after the save');
    } finally {
      store.dispose();
    }
  });
});

suite('index/watcher: registerSaveWatcher', () => {
  test('returns a Disposable that unsubscribes the save listener on dispose', () => {
    const store = new EventIndexStore();
    const fakeContext = {
      subscriptions: [],
      extension: { id: 'dvlprlife.al-eventlens' }
    } as unknown as vscode.ExtensionContext;
    try {
      const disposable = registerSaveWatcher(fakeContext, store);
      assert.ok(typeof disposable.dispose === 'function',
        'registerSaveWatcher must return a Disposable');
      // Should not throw.
      disposable.dispose();
      // Calling dispose twice is also safe per the vscode.Disposable contract.
      disposable.dispose();
    } finally {
      store.dispose();
    }
  });
});

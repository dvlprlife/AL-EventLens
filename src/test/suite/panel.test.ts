import * as assert from 'assert';
import * as vscode from 'vscode';
import type { Publisher, Subscriber } from '../../al/types';
import type { EventIndex } from '../../index/indexer';
import { EventIndexStore } from '../../index/store';
import { getSelectedPublisher, openPanel, postSelectToPanel } from '../../ui/panel';
import { renderPanelHtml } from '../../ui/panelHtml';

// ─── Fake WebviewPanel ───────────────────────────────────────────────────

class FakePanel {
  public posts: unknown[] = [];
  public revealCalls = 0;
  public receivedHandlers: Array<(msg: unknown) => void> = [];
  public disposeHandlers: Array<() => void> = [];
  public panel: vscode.WebviewPanel;

  constructor() {
    const self = this;
    const webview = {
      html: '',
      postMessage: (msg: unknown): Thenable<boolean> => {
        self.posts.push(msg);
        return Promise.resolve(true);
      },
      onDidReceiveMessage: (handler: (msg: unknown) => void): vscode.Disposable => {
        self.receivedHandlers.push(handler);
        return { dispose: (): void => undefined };
      },
      cspSource: '',
      options: {},
      asWebviewUri: (u: vscode.Uri): vscode.Uri => u
    } as unknown as vscode.Webview;

    this.panel = {
      webview,
      viewColumn: vscode.ViewColumn.Beside,
      title: 'AL EventLens',
      visible: true,
      active: true,
      reveal: (): void => { self.revealCalls++; },
      onDidDispose: (handler: () => void): vscode.Disposable => {
        self.disposeHandlers.push(handler);
        return { dispose: (): void => undefined };
      },
      onDidChangeViewState: (): vscode.Disposable => ({ dispose: (): void => undefined }),
      dispose: (): void => self.disposeHandlers.slice().forEach((h) => h())
    } as unknown as vscode.WebviewPanel;
  }

  fireReceive(msg: unknown): void {
    this.receivedHandlers.slice().forEach((h) => h(msg));
  }

  fireDispose(): void {
    this.disposeHandlers.slice().forEach((h) => h());
  }
}

// ─── Patch helpers ──────────────────────────────────────────────────────

const originalCreate = vscode.window.createWebviewPanel;
const originalExecute = vscode.commands.executeCommand;

let createCalls: FakePanel[] = [];
let executeCalls: Array<{ command: string; args: unknown[] }> = [];

function patchCreate(): void {
  Object.defineProperty(vscode.window, 'createWebviewPanel', {
    configurable: true,
    value: (): vscode.WebviewPanel => {
      const fp = new FakePanel();
      createCalls.push(fp);
      return fp.panel;
    }
  });
}

function restoreCreate(): void {
  Object.defineProperty(vscode.window, 'createWebviewPanel', {
    configurable: true,
    value: originalCreate
  });
  createCalls = [];
}

function patchExecute(): void {
  Object.defineProperty(vscode.commands, 'executeCommand', {
    configurable: true,
    value: <T>(command: string, ...args: unknown[]): Thenable<T> => {
      executeCalls.push({ command, args });
      return Promise.resolve(undefined as unknown as T);
    }
  });
}

function restoreExecute(): void {
  Object.defineProperty(vscode.commands, 'executeCommand', {
    configurable: true,
    value: originalExecute
  });
  executeCalls = [];
}

// ─── Fixtures ───────────────────────────────────────────────────────────

const fakeContext = {
  subscriptions: [] as vscode.Disposable[],
  extension: { id: 'dvlprlife.al-eventlens' }
} as unknown as vscode.ExtensionContext;

function makePublisher(name: string, eventName: string): Publisher {
  return {
    owner: { kind: 'codeunit', name },
    eventName,
    kind: 'integration'
  };
}

function makeSubscriber(targetName: string, targetEvent: string): Subscriber {
  return {
    owner: { kind: 'codeunit', name: 'Some Subscriber' },
    target: { kind: 'codeunit', name: targetName },
    targetEvent,
    location: new vscode.Location(vscode.Uri.parse('file:///x.al'), new vscode.Position(0, 0)),
    resolved: true
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────

suite('ui/panelHtml: renderPanelHtml', () => {
  test('embeds the supplied nonce in the script tag attribute and the CSP', () => {
    const html = renderPanelHtml('abc123');
    assert.ok(html.includes('nonce="abc123"'),
      'must contain nonce="abc123" as an attribute');
    assert.ok(/<script\b[^>]*nonce="abc123"/.test(html),
      'nonce must be on the inline <script> tag');
    assert.ok(html.includes("'nonce-abc123'"),
      'CSP meta must reference the nonce in script-src');
    assert.ok(html.includes('default-src'),
      'CSP meta tag must be present');
  });

  test('returns a self-contained document with no external resources', () => {
    const html = renderPanelHtml('nonce123');
    assert.ok(/^<!doctype html>/i.test(html), 'starts with <!doctype html>');
    assert.ok(!/<link\b/i.test(html), 'no external stylesheets');
    assert.ok(!/<script\b[^>]*\bsrc=/i.test(html), 'no external scripts');
  });
});

suite('ui/panel: openPanel singleton + store wiring', () => {
  teardown(() => {
    // Drain any panels the test created so the module-level activePanel
    // resets via the onDidDispose handler.
    for (const fp of createCalls.slice()) {
      fp.fireDispose();
    }
    restoreCreate();
    restoreExecute();
  });

  test('first call creates a panel; second call reveals the existing one (singleton)', () => {
    patchCreate();
    const store = new EventIndexStore();
    try {
      openPanel(fakeContext, store);
      assert.strictEqual(createCalls.length, 1,
        'first openPanel should create exactly one panel');
      assert.strictEqual(createCalls[0].revealCalls, 0,
        'first openPanel should not call reveal on the new panel');

      openPanel(fakeContext, store);
      assert.strictEqual(createCalls.length, 1,
        'second openPanel must reuse the existing panel (no second createWebviewPanel)');
      assert.strictEqual(createCalls[0].revealCalls, 1,
        'second openPanel must call reveal() on the existing panel');
    } finally {
      store.dispose();
    }
  });

  test('store.set after openPanel posts a fresh {type:"index", ...} payload to the webview', () => {
    patchCreate();
    const store = new EventIndexStore();
    try {
      openPanel(fakeContext, store);
      const fake = createCalls[0];

      // The initial empty index gets posted on open.
      assert.strictEqual(fake.posts.length, 1, 'initial index post on open');
      assert.strictEqual((fake.posts[0] as { type: string }).type, 'index');

      const next: EventIndex = {
        publishers: [makePublisher('My Codeunit', 'OnAfterFoo')],
        subscribers: [makeSubscriber('My Codeunit', 'OnAfterFoo')],
        appMeta: new Map()
      };
      store.set(next);

      assert.strictEqual(fake.posts.length, 2,
        'second post should fire when the store changes');
      const last = fake.posts[1] as {
        type: string;
        publishers: ReadonlyArray<Publisher>;
        subscribers: ReadonlyArray<Subscriber>;
      };
      assert.strictEqual(last.type, 'index');
      assert.deepStrictEqual(last.publishers, next.publishers);
      assert.deepStrictEqual(last.subscribers, next.subscribers);
    } finally {
      store.dispose();
    }
  });

  test('webview posting {type:"gotoSubscriber"} dispatches alEventLens.gotoSubscriber with the location', () => {
    patchCreate();
    patchExecute();
    const store = new EventIndexStore();
    try {
      openPanel(fakeContext, store);
      const fake = createCalls[0];
      const loc = new vscode.Location(
        vscode.Uri.parse('file:///workspace/MySub.al'),
        new vscode.Position(5, 0)
      );
      fake.fireReceive({ type: 'gotoSubscriber', subscriber: { location: loc } });

      const dispatched = executeCalls.find((c) => c.command === 'alEventLens.gotoSubscriber');
      assert.ok(dispatched, 'expected alEventLens.gotoSubscriber to be dispatched');
      assert.strictEqual(dispatched!.args[0], loc,
        'first arg must be the location forwarded from the webview message');
    } finally {
      store.dispose();
    }
  });

  test('postSelectToPanel after openPanel posts a {type:"select", publisher} message', () => {
    patchCreate();
    const store = new EventIndexStore();
    try {
      openPanel(fakeContext, store);
      const fake = createCalls[0];
      const before = fake.posts.length;

      const pub = makePublisher('Foo', 'OnBar');
      postSelectToPanel(pub);

      assert.strictEqual(fake.posts.length, before + 1,
        'postSelectToPanel must post exactly one message');
      const last = fake.posts[fake.posts.length - 1] as {
        type: string;
        publisher: Publisher;
      };
      assert.strictEqual(last.type, 'select');
      assert.strictEqual(last.publisher, pub,
        'publisher payload must be the exact object passed in');
    } finally {
      store.dispose();
    }
  });

  test('webview "selectionChanged" message updates getSelectedPublisher()', () => {
    patchCreate();
    const store = new EventIndexStore();
    try {
      openPanel(fakeContext, store);
      const fake = createCalls[0];

      // Nothing has been selected yet.
      assert.strictEqual(getSelectedPublisher(), undefined,
        'getSelectedPublisher() should start undefined on a fresh panel');

      const pub = makePublisher('Sales-Post', 'OnAfterPostSalesDoc');
      fake.fireReceive({ type: 'selectionChanged', publisher: pub });
      assert.strictEqual(getSelectedPublisher(), pub,
        'getSelectedPublisher() should reflect the most recent selectionChanged payload');

      // Webview can also signal "cleared" with publisher: null.
      fake.fireReceive({ type: 'selectionChanged', publisher: null });
      assert.strictEqual(getSelectedPublisher(), undefined,
        'getSelectedPublisher() should clear when publisher is null');
    } finally {
      store.dispose();
    }
  });

  test('postSelectToPanel also updates getSelectedPublisher() synchronously', () => {
    patchCreate();
    const store = new EventIndexStore();
    try {
      openPanel(fakeContext, store);
      const pub = makePublisher('Reveal Target', 'OnSomething');
      postSelectToPanel(pub);
      assert.strictEqual(getSelectedPublisher(), pub,
        'getSelectedPublisher() should reflect the just-posted selection without a webview round-trip');
    } finally {
      store.dispose();
    }
  });

  test('panel dispose clears getSelectedPublisher()', () => {
    patchCreate();
    const store = new EventIndexStore();
    try {
      openPanel(fakeContext, store);
      const fake = createCalls[0];
      fake.fireReceive({ type: 'selectionChanged', publisher: makePublisher('X', 'Y') });
      assert.notStrictEqual(getSelectedPublisher(), undefined);
      fake.fireDispose();
      assert.strictEqual(getSelectedPublisher(), undefined,
        'getSelectedPublisher() should return undefined after the panel is disposed');
    } finally {
      store.dispose();
    }
  });
});

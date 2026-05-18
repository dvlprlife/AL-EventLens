import * as assert from 'assert';
import * as vscode from 'vscode';
import type { ObjectKind, Publisher, Subscriber } from '../../al/types';
import {
  runExportMermaid,
  type ClipboardApi,
  type ExportMermaidDeps,
  type WindowMessageApi
} from '../../commands/exportMermaid';
import { EventIndexStore } from '../../index/store';

// ─── Fakes ──────────────────────────────────────────────────────────────

interface CapturedMessage { readonly kind: 'warning' | 'info' | 'error'; readonly text: string; }

function makeWindow(): WindowMessageApi & { messages: CapturedMessage[] } {
  const messages: CapturedMessage[] = [];
  return {
    messages,
    showWarningMessage: (text: string): Thenable<string | undefined> => {
      messages.push({ kind: 'warning', text });
      return Promise.resolve(undefined);
    },
    showInformationMessage: (text: string): Thenable<string | undefined> => {
      messages.push({ kind: 'info', text });
      return Promise.resolve(undefined);
    },
    showErrorMessage: (text: string): Thenable<string | undefined> => {
      messages.push({ kind: 'error', text });
      return Promise.resolve(undefined);
    }
  };
}

function makeClipboard(
  opts?: { rejectWith?: unknown }
): ClipboardApi & { writes: string[] } {
  const writes: string[] = [];
  return {
    writes,
    writeText: (value: string): Thenable<void> => {
      writes.push(value);
      if (opts?.rejectWith !== undefined) {
        return Promise.reject(opts.rejectWith);
      }
      return Promise.resolve();
    }
  };
}

function makeDeps(opts?: { rejectClipboardWith?: unknown }): ExportMermaidDeps & {
  clipboard: ReturnType<typeof makeClipboard>;
  window: ReturnType<typeof makeWindow>;
} {
  return {
    clipboard: makeClipboard({ rejectWith: opts?.rejectClipboardWith }),
    window: makeWindow()
  };
}

// ─── Fixtures ───────────────────────────────────────────────────────────

function makePublisher(name: string, eventName: string): Publisher {
  return {
    owner: { kind: 'codeunit', name },
    eventName,
    kind: 'integration'
  };
}

function makeSubscriber(
  targetKind: ObjectKind,
  targetName: string,
  targetEvent: string
): Subscriber {
  return {
    owner: { kind: 'codeunit', name: 'Some Subscriber' },
    target: { kind: targetKind, name: targetName },
    targetEvent,
    location: new vscode.Location(vscode.Uri.parse('file:///x.al'), new vscode.Position(0, 0)),
    resolved: true
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────

suite('commands/exportMermaid: runExportMermaid', () => {
  test('no publisher → warning toast, no clipboard write', async () => {
    const store = new EventIndexStore();
    try {
      const deps = makeDeps();
      await runExportMermaid(undefined, store, deps);

      assert.strictEqual(deps.clipboard.writes.length, 0, 'clipboard must not be written when no publisher');
      assert.strictEqual(deps.window.messages.length, 1);
      assert.strictEqual(deps.window.messages[0].kind, 'warning');
      assert.ok(deps.window.messages[0].text.includes('select a publisher'),
        `expected warning to mention selecting a publisher; got: ${deps.window.messages[0].text}`);
    } finally {
      store.dispose();
    }
  });

  test('publisher with matching subscribers → clipboard gets Mermaid + info toast with count', async () => {
    const store = new EventIndexStore();
    try {
      const pub = makePublisher('Sales-Post', 'OnAfterPostSalesDoc');
      store.set({
        publishers: [pub],
        subscribers: [
          makeSubscriber('codeunit', 'Sales-Post', 'OnAfterPostSalesDoc'),
          makeSubscriber('codeunit', 'Sales-Post', 'OnAfterPostSalesDoc'),
          makeSubscriber('codeunit', 'Other', 'OnNothing')
        ],
        appMeta: new Map()
      });

      const deps = makeDeps();
      await runExportMermaid(pub, store, deps);

      assert.strictEqual(deps.clipboard.writes.length, 1);
      const mermaid = deps.clipboard.writes[0];
      assert.ok(mermaid.startsWith('graph LR\n'), `expected Mermaid graph LR header; got: ${mermaid.slice(0, 30)}`);
      assert.ok(mermaid.includes('Sales-Post'),
        'mermaid output should reference the publisher owner name');

      const info = deps.window.messages.find((m) => m.kind === 'info');
      assert.ok(info, 'expected an info toast');
      assert.ok(info!.text.includes('2 subscribers'),
        `expected "2 subscribers" in the info toast; got: ${info!.text}`);
    } finally {
      store.dispose();
    }
  });

  test('pluralization: 1 subscriber → singular "subscriber", 0 / 2+ → plural', async () => {
    const store = new EventIndexStore();
    try {
      const pub = makePublisher('Sales-Post', 'OnAfterPostSalesDoc');

      // 1 subscriber → singular
      store.set({
        publishers: [pub],
        subscribers: [makeSubscriber('codeunit', 'Sales-Post', 'OnAfterPostSalesDoc')],
        appMeta: new Map()
      });
      const deps1 = makeDeps();
      await runExportMermaid(pub, store, deps1);
      const info1 = deps1.window.messages.find((m) => m.kind === 'info')!;
      assert.ok(/\b1 subscriber\b/.test(info1.text) && !/1 subscribers/.test(info1.text),
        `expected "1 subscriber" (singular); got: ${info1.text}`);

      // 0 subscribers → plural
      store.set({ publishers: [pub], subscribers: [], appMeta: new Map() });
      const deps0 = makeDeps();
      await runExportMermaid(pub, store, deps0);
      const info0 = deps0.window.messages.find((m) => m.kind === 'info')!;
      assert.ok(info0.text.includes('0 subscribers'),
        `expected "0 subscribers" (plural); got: ${info0.text}`);
    } finally {
      store.dispose();
    }
  });

  test('clipboard write rejection → error toast and no info toast', async () => {
    const store = new EventIndexStore();
    try {
      const pub = makePublisher('Sales-Post', 'OnAfterPostSalesDoc');
      store.set({ publishers: [pub], subscribers: [], appMeta: new Map() });

      const deps = makeDeps({ rejectClipboardWith: new Error('clipboard busy') });
      await runExportMermaid(pub, store, deps);

      assert.strictEqual(deps.clipboard.writes.length, 1, 'writeText was attempted');
      const info = deps.window.messages.find((m) => m.kind === 'info');
      assert.strictEqual(info, undefined, 'no info toast on rejection');
      const error = deps.window.messages.find((m) => m.kind === 'error');
      assert.ok(error, 'error toast must fire on rejection');
      assert.ok(error!.text.includes('clipboard write failed'),
        `expected error toast to mention "clipboard write failed"; got: ${error!.text}`);
    } finally {
      store.dispose();
    }
  });
});

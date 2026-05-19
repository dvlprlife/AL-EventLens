import * as assert from 'assert';
import * as vscode from 'vscode';

// ─── Patch harness for vscode.window.showTextDocument /
// showInformationMessage. The alEventLens.gotoSubscriber command is
// registered in activate(), already live in the test extension host —
// we exercise it via executeCommand and observe what the patched windows
// methods received. ───────────────────────────────────────────────────────

const realShowTextDocument = vscode.window.showTextDocument;
const realShowInformationMessage = vscode.window.showInformationMessage;

interface ShownDoc {
  readonly uri: vscode.Uri;
  readonly selection: vscode.Range | undefined;
}

let shown: ShownDoc[];
let infoMessages: string[];

function patchWindow(): void {
  shown = [];
  infoMessages = [];
  Object.defineProperty(vscode.window, 'showTextDocument', {
    configurable: true,
    value: (
      uri: vscode.Uri,
      options?: vscode.TextDocumentShowOptions
    ): Thenable<vscode.TextEditor> => {
      shown.push({ uri, selection: options?.selection as vscode.Range | undefined });
      return Promise.resolve({} as vscode.TextEditor);
    }
  });
  Object.defineProperty(vscode.window, 'showInformationMessage', {
    configurable: true,
    value: (message: string): Thenable<string | undefined> => {
      infoMessages.push(message);
      return Promise.resolve(undefined);
    }
  });
}

function restoreWindow(): void {
  Object.defineProperty(vscode.window, 'showTextDocument', {
    configurable: true,
    value: realShowTextDocument
  });
  Object.defineProperty(vscode.window, 'showInformationMessage', {
    configurable: true,
    value: realShowInformationMessage
  });
}

// ─── Tests ──────────────────────────────────────────────────────────────

suite('extension: alEventLens.gotoSubscriber command body', () => {
  teardown(restoreWindow);

  test('no-arg invocation early-returns: no showTextDocument, no error', async () => {
    patchWindow();
    await vscode.commands.executeCommand('alEventLens.gotoSubscriber');
    assert.strictEqual(shown.length, 0,
      'palette invocation with no args must early-return rather than calling showTextDocument');
    assert.strictEqual(infoMessages.length, 0);
  });

  test('REGRESSION: cloned `{_start, _end}` range shape opens the file at the right position', async () => {
    // The actual shape webview postMessage produces: vscode.Range exposes
    // start/end as class getters with data in internal _start/_end slots;
    // the public getters do not survive structured clone. Before PR #60,
    // the command read loc.range.end.line directly and crashed silently.
    patchWindow();
    const clonedLocation = {
      uri: { scheme: 'file', authority: '', path: '/workspace/MySub.al', query: '', fragment: '' },
      range: {
        _start: { line: 12, character: 4 },
        _end:   { line: 12, character: 4 }
      }
    };
    await vscode.commands.executeCommand('alEventLens.gotoSubscriber', clonedLocation);
    assert.strictEqual(shown.length, 1, 'showTextDocument must fire exactly once');
    assert.strictEqual(shown[0].uri.scheme, 'file');
    assert.strictEqual(shown[0].uri.path, '/workspace/MySub.al');
    assert.ok(shown[0].selection instanceof vscode.Range);
    assert.strictEqual(shown[0].selection!.start.line, 12);
    assert.strictEqual(shown[0].selection!.start.character, 4);
    assert.strictEqual(shown[0].selection!.end.line, 12);
    assert.strictEqual(shown[0].selection!.end.character, 4);
  });

  test('plain `{start, end}` range shape (JSON-style serialization) also works', async () => {
    patchWindow();
    const clonedLocation = {
      uri: { scheme: 'file', authority: '', path: '/workspace/Other.al', query: '', fragment: '' },
      range: {
        start: { line: 3, character: 0 },
        end:   { line: 3, character: 17 }
      }
    };
    await vscode.commands.executeCommand('alEventLens.gotoSubscriber', clonedLocation);
    assert.strictEqual(shown.length, 1);
    assert.strictEqual(shown[0].selection!.start.line, 3);
    assert.strictEqual(shown[0].selection!.end.character, 17);
  });

  test('real in-memory vscode.Location (CodeLens / Tree caller) still works', async () => {
    patchWindow();
    const loc = new vscode.Location(
      vscode.Uri.parse('file:///workspace/Tree.al'),
      new vscode.Position(7, 2)
    );
    await vscode.commands.executeCommand('alEventLens.gotoSubscriber', loc);
    assert.strictEqual(shown.length, 1);
    assert.strictEqual(shown[0].uri.path, '/workspace/Tree.al');
    assert.strictEqual(shown[0].selection!.start.line, 7);
    assert.strictEqual(shown[0].selection!.start.character, 2);
  });

  test('al-eventlens-app: scheme triggers the friendly notice and does NOT open an editor', async () => {
    // Subscribers parsed from .app bundled src/**/*.al carry a synthetic
    // `al-eventlens-app:` URI — VS Code can't open that scheme, so the
    // command short-circuits with a notification rather than letting
    // showTextDocument throw.
    patchWindow();
    const clonedLocation = {
      uri: {
        scheme: 'al-eventlens-app', authority: '',
        path: '/abc-def/src/Sales-Post.al', query: '', fragment: ''
      },
      range: { _start: { line: 0, character: 0 }, _end: { line: 0, character: 0 } }
    };
    await vscode.commands.executeCommand('alEventLens.gotoSubscriber', clonedLocation);
    assert.strictEqual(shown.length, 0,
      'al-eventlens-app: must not be passed to showTextDocument');
    assert.strictEqual(infoMessages.length, 1);
    assert.ok(infoMessages[0].includes('packaged .app'),
      `expected notice to mention packaged .app; got: ${infoMessages[0]}`);
  });

  test('degenerate empty range still opens the file at (0, 0) instead of crashing', async () => {
    // The reviveRange helper falls back to (0,0) for fully missing position
    // info — important so a corrupted message doesn't take the click flow
    // down with it. Better to open the file at line 1 than to silently no-op.
    patchWindow();
    const clonedLocation = {
      uri: { scheme: 'file', authority: '', path: '/workspace/Degenerate.al', query: '', fragment: '' },
      range: {}
    };
    await vscode.commands.executeCommand('alEventLens.gotoSubscriber', clonedLocation);
    assert.strictEqual(shown.length, 1);
    assert.strictEqual(shown[0].selection!.start.line, 0);
    assert.strictEqual(shown[0].selection!.end.line, 0);
  });
});

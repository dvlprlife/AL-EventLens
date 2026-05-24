import * as assert from 'assert';
import * as vscode from 'vscode';
import type { Publisher, Subscriber } from '../../al/types';
import type { EventIndex } from '../../index/indexer';
import { EventIndexStore } from '../../index/store';
import { getSelectedPublisher, openPanel, postRevealObjectToPanel, postRevealSubscriberToPanel, postSelectToPanel } from '../../ui/panel';
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

  test('embeds the .detail-signature CSS class and the renderSignature helper for the parameter line', () => {
    const html = renderPanelHtml('nonce123');
    assert.ok(html.includes('.detail-signature'),
      '.detail-signature CSS rule must be present so the param line is themed');
    assert.ok(html.includes('function renderSignature(params)'),
      'renderSignature helper must be inlined for the webview to call it');
    assert.ok(/sig\.className\s*=\s*['"]detail-signature['"]/.test(html),
      'renderDetail must instantiate a <div class="detail-signature"> when the publisher has parameters');
  });

  test('embeds the object: filter prefix wiring (parseSearch, passesFilter, buildSearchText)', () => {
    const html = renderPanelHtml('nonce123');
    assert.ok(html.includes("'object:'"),
      'parseSearch and buildSearchText must reference the object: prefix string');
    assert.ok(/parsed\.object/.test(html),
      'passesFilter / buildSearchText must read parsed.object');
  });

  test('embeds the tokenizeSearch helper so quoted "Sales Header" survives as one token', () => {
    const html = renderPanelHtml('nonce123');
    assert.ok(html.includes('function tokenizeSearch(text)'),
      'tokenizeSearch must be inlined so prefixes like object:"Sales Header" round-trip');
  });

  test('embeds the reveal-message handler so tree clicks and CodeLens can drive the panel filter', () => {
    const html = renderPanelHtml('nonce123');
    assert.ok(/m\.type\s*===\s*['"]reveal['"]/.test(html),
      "renderPanelHtml's message router must handle the 'reveal' message");
    assert.ok(/searchEl\.value\s*=\s*m\.search/.test(html),
      'reveal handler must assign m.search into the search input');
  });

  test('subscriber click handler attaches for resolved AND unresolved rows; no cursor:default override', () => {
    // Regression: previously the click handler was nested inside the
    // resolved branch, so clicking an unresolved subscriber did nothing
    // even though its own source location is always valid for parsed
    // subscribers (the `resolved` flag is about the TARGET publisher).
    const html = renderPanelHtml('nonce123');
    assert.ok(!/\.sub-list\s+li\.unresolved\s*\{\s*cursor:\s*default/.test(html),
      'CSS must NOT override cursor to default on .sub-list li.unresolved — those rows are now clickable');
    // Exactly one gotoSubscriber postMessage in the rendered JS — wired
    // once for the row, not duplicated across resolved/unresolved branches.
    const matches = html.match(/postMessage\(\{\s*type:\s*['"]gotoSubscriber['"]/g) ?? [];
    assert.strictEqual(matches.length, 1,
      `gotoSubscriber postMessage must be wired exactly once (outside the resolved/unresolved branch); got ${matches.length}`);
  });

  test('embeds the AL-style identity-selector parser (`<kind>::<name>` / `<kind>::"name"`)', () => {
    const html = renderPanelHtml('nonce123');
    // The exact regex literal used to detect identity tokens — strong signal
    // the parser branch is wired in renderPanelHtml's inline JS.
    assert.ok(html.includes('/^(\\w+)::(?:"([^"]*)"|(\\S+))$/'),
      'parseSearch must contain the identity-selector regex literal');
    assert.ok(html.includes('objectIdentity'),
      'passesFilter / buildSearchText must reference objectIdentity');
    // Dropping objectIdentity when the kind dropdown changes is the only
    // way to keep dropdown-driven and identity-driven filters consistent.
    assert.ok(/parsed\.objectIdentity\s*=\s*null/.test(html),
      'applyToken must clear objectIdentity when the kind dropdown changes');
  });

  test('embeds the Publishers/Subscribers mode toggle and a dedicated subscriber list', () => {
    const html = renderPanelHtml('nonce123');
    assert.ok(/id="modePublishers"/.test(html), 'mode toggle must include a Publishers button');
    assert.ok(/id="modeSubscribers"/.test(html), 'mode toggle must include a Subscribers button');
    assert.ok(/<ul id="subscribers"/.test(html),
      'left pane must include a #subscribers list element');
    assert.ok(html.includes('function renderSubscriberList()'),
      'renderSubscriberList helper must be inlined for Subscribers mode');
    assert.ok(html.includes('function passesSubscriberFilter('),
      'passesSubscriberFilter must be inlined so the subscriber list is searchable');
  });

  test('the subscriber list is built from the full subscribers array — unresolved rows included', () => {
    // The Subscribers mode iterates `subscribers` directly (not the
    // publisher-keyed index), so an unresolved subscriber whose target app
    // is missing still gets a row — the whole reason the section exists.
    const html = renderPanelHtml('nonce123');
    assert.ok(/subscribers\.forEach\(function \(s\) \{/.test(html),
      'renderSubscriberList must iterate every subscriber, resolved or not');
    assert.ok(html.includes("badge-warn"),
      'unresolved rows must reuse the warning badge class');
  });

  test('embeds the revealSubscriber message handler so Subscribers-tree clicks drive the panel', () => {
    const html = renderPanelHtml('nonce123');
    assert.ok(/m\.type\s*===\s*['"]revealSubscriber['"]/.test(html),
      "renderPanelHtml's message router must handle the 'revealSubscriber' message");
    assert.ok(html.includes("setMode('subscribers')"),
      'the revealSubscriber handler must switch the panel to Subscribers mode');
  });

  test('subKey folds in the start line so two subscribers sharing owner/target/event in one file stay distinct', () => {
    // PR-review finding: keying a subscriber row on path alone collides two
    // [EventSubscriber] procedures in the same file on the same target event.
    const html = renderPanelHtml('nonce123');
    assert.ok(html.includes("pathOf(s.location) || '', lineOf(s.location)"),
      'subKey must append lineOf(s.location) after the path component');
    assert.ok(/r\.start \|\| r\._start/.test(html),
      'lineOf must read the cloned _start shape, not only the stripped .start getter');
  });

  test('the search box re-renders through a debounce, not on every raw input event', () => {
    // Perf: renderList()/renderSubscriberList() rebuild the whole list DOM,
    // so debouncing keeps a large workspace responsive while typing.
    const html = renderPanelHtml('nonce123');
    assert.ok(/function debounce\(/.test(html),
      'a debounce helper must be defined in the webview script');
    assert.ok(html.includes("addEventListener('input', debounce(render"),
      'the search input listener must be wrapped in debounce()');
  });

  test('the panel lists are row-capped so a huge workspace cannot freeze the webview', () => {
    // #87 — renderList/renderSubscriberList rebuild the whole DOM; an
    // unbounded list at BaseApp scale froze the panel on open.
    const html = renderPanelHtml('nonce123');
    assert.ok(/const MAX_LIST_ROWS\s*=\s*\d+/.test(html),
      'a MAX_LIST_ROWS cap constant must be defined');
    assert.ok(html.includes('shown >= MAX_LIST_ROWS && k === selectedKey'),
      'renderList must mark the selected past-cap row as a cap exception');
    assert.ok(html.includes('shown >= MAX_LIST_ROWS && k === selectedSubKey'),
      'renderSubscriberList must mark the selected past-cap row as a cap exception');
    assert.ok(html.includes('shown >= MAX_LIST_ROWS && !isCapException'),
      'past-cap rows that are not the cap exception must be dropped');
    assert.ok(html.includes("'Showing ' + shown + ' of ' + total"),
      'a capped list must append a notice row showing rendered-of-total counts');
  });

  test('the webview handles an incremental fileUpdate message', () => {
    const html = renderPanelHtml('nonce123');
    assert.ok(/m\.type === ['"]fileUpdate['"]/.test(html),
      "the message router must handle the 'fileUpdate' incremental message");
    assert.ok(html.includes('u.path !== m.uriPath'),
      'fileUpdate must replace the saved file publishers, matched by URI path');
  });

  test('renderSubscriberDetail looks the selected subscriber up via an index, not a linear scan', () => {
    const html = renderPanelHtml('nonce123');
    assert.ok(html.includes('subscribersBySubKey.set(subKey(s), s)'),
      'rebuildSubscribersIndex must populate a subKey-keyed index');
    assert.ok(html.includes('subscribersBySubKey.get(selectedSubKey)'),
      'renderSubscriberDetail must use the index for an O(1) lookup');
  });

  test('a line-shifting fileUpdate relocates the selected subscriber by line-insensitive identity (defect 1)', () => {
    // The fileUpdate handler must call relocateSelectedSubKey() after
    // rebuildSubscribersIndex() so a save that shifts the [EventSubscriber]
    // attribute's line still resolves to the same subscriber. The relocator
    // matches on (owner.kind, owner.name, target.kind, target.name,
    // targetEvent, path) — every subKey component except the line.
    const html = renderPanelHtml('nonce123');
    assert.ok(html.includes('function subIdentityKey(s)'),
      'a line-insensitive identity helper must be defined for the relocator');
    assert.ok(html.includes('function relocateSelectedSubKey()'),
      'the post-fileUpdate relocator helper must be defined');
    assert.ok(/relocateSelectedSubKey\(\)/.test(html),
      'the fileUpdate handler must call relocateSelectedSubKey() after rebuildSubscribersIndex()');
    // The relocator must clear the selection on zero or multiple matches so
    // the detail pane resets cleanly instead of getting stuck on a stale key.
    assert.ok(/selectedSubKey\s*=\s*null/.test(html),
      'relocateSelectedSubKey must null the selection when no unambiguous match exists');
  });

  test('the "Showing X of Y" notice never reports more than MAX_LIST_ROWS for either list (defect 3)', () => {
    // The cap-exception path lets the selected past-cap row render, but the
    // shown counter must not advance for it — otherwise the notice reports
    // MAX_LIST_ROWS + 1, which is wrong (the user already sees N capped rows
    // plus a separately-rendered selected row).
    const html = renderPanelHtml('nonce123');
    // The cap-exception branch is now tracked in a separate counter that
    // does NOT contribute to `shown` — appears in both renderList and
    // renderSubscriberList.
    const capCounterMatches = html.match(/capExceptionRendered/g) ?? [];
    assert.ok(capCounterMatches.length >= 4,
      `both lists must track cap-exception renders in a dedicated counter (got ${capCounterMatches.length} mentions; expected >= 4 for two lists)`);
    // The cap notice must compare total against the sum of shown + cap-exception
    // (or otherwise gate so the notice only fires when truly more rows were filtered out).
    assert.ok(/total > shown \+ capExceptionRendered/.test(html),
      'the cap-notice gate must consider the cap-exception render so the notice only fires when extra rows exist');
  });

  test('select handler renders before findLiByKey so past-cap rows get a highlight (defect 2)', () => {
    // Without rendering first, findLiByKey returns null for a past-cap row
    // because the DOM was built around the OLD selectedKey. The 'reveal'
    // handler already does this (assigns selectKey, then renders); the
    // 'select' handler now mirrors that pattern.
    const html = renderPanelHtml('nonce123');
    // Find the 'select' branch and assert it assigns selectedKey + renders
    // BEFORE looking up the LI in the DOM.
    const selectBranch = html.split("m.type === 'select'")[1] ?? '';
    const elseAfter = selectBranch.split('} else if')[0];
    assert.ok(/selectedKey\s*=\s*newKey/.test(elseAfter),
      "the 'select' handler must assign selectedKey before rendering");
    const renderIdx = elseAfter.indexOf('render()');
    const findLiIdx = elseAfter.indexOf('findLiByKey(newKey)');
    assert.ok(renderIdx !== -1, "the 'select' handler must call render()");
    assert.ok(findLiIdx !== -1, "the 'select' handler must call findLiByKey");
    assert.ok(renderIdx < findLiIdx,
      "the 'select' handler must call render() BEFORE findLiByKey so a past-cap row is materialized");
  });

  test('relocateSelectedSubKey survives a subscriber whose path contains a literal "|" (issue #117 defect 3)', () => {
    // Regression: the previous subKey delimiter was '|', so a POSIX path
    // (or synthetic URI) containing a literal '|' would cause the relocator's
    // selectedSubKey.split('|') to truncate the path mid-character, leaving
    // wantIdentity == something that no subIdentityKey could match — the
    // selection silently cleared instead of being relocated by line-shift.
    // The fix swaps the delimiter to a C0 control character (U+0001) that
    // cannot legally appear in any AL identifier or URI representation.
    // This test exercises the actual webview helpers by extracting them
    // from the rendered HTML and evaluating them in a controlled scope.

    const html = renderPanelHtml('nonce123');
    const scriptMatch = /<script\b[^>]*>([\s\S]*?)<\/script>/.exec(html);
    assert.ok(scriptMatch, 'inline <script> must be present in the rendered HTML');
    const script = scriptMatch![1];

    // Pluck the helper definitions we need. They live as named function
    // declarations in the inline JS; extract by brace-counting since the
    // bodies contain nested `{}` (e.g. for-loops inside relocate).
    function extractFn(name: string): string {
      const sig = 'function ' + name + '(';
      const start = script.indexOf(sig);
      assert.ok(start !== -1, `helper ${name} must be defined in the panel script`);
      // Walk forward to the opening brace of the function body.
      let i = script.indexOf('{', start);
      assert.ok(i !== -1, `helper ${name} must have an opening brace`);
      let depth = 1;
      i++;
      while (i < script.length && depth > 0) {
        const ch = script[i];
        if (ch === '{') {
          depth++;
        } else if (ch === '}') {
          depth--;
        } else if (ch === "'" || ch === '"') {
          // Skip string literals so a `}` inside a string doesn't unbalance.
          const quote = ch;
          i++;
          while (i < script.length && script[i] !== quote) {
            if (script[i] === '\\') {
              i++; // skip escape
            }
            i++;
          }
        }
        i++;
      }
      assert.ok(depth === 0, `helper ${name} body must be balanced`);
      return script.slice(start, i);
    }
    const fnSubKey = extractFn('subKey');
    const fnSubIdentityKey = extractFn('subIdentityKey');
    const fnPathOf = extractFn('pathOf');
    const fnLineOf = extractFn('lineOf');
    const fnRelocate = extractFn('relocateSelectedSubKey');

    // Build a controlled scope mirroring the webview's let-bindings. The
    // Function ctor returns a callable that lets the test drive
    // relocateSelectedSubKey via shared closure variables.
    const driver = new Function(
      'subscribers',
      'selectedSubKeyIn',
      `let selectedSubKey = selectedSubKeyIn;
       let subscribersBySubKey = new Map();
       ${fnPathOf}
       ${fnLineOf}
       ${fnSubKey}
       ${fnSubIdentityKey}
       subscribers.forEach(function (s) { subscribersBySubKey.set(subKey(s), s); });
       ${fnRelocate}
       relocateSelectedSubKey();
       return { selectedSubKey: selectedSubKey, subKeyOf: subscribers.length ? subKey(subscribers[0]) : null };`
    ) as (subs: unknown[], k: string | null) => { selectedSubKey: string | null; subKeyOf: string | null };

    // A subscriber on a path containing '|'. The line shifts from 10 to 20
    // (simulating an upstream edit that pushed the [EventSubscriber]
    // attribute down) — its identity (owner, target, event, path) is
    // unchanged, so the relocator must find it.
    const pathWithPipe = '/tmp/foo|bar/My Codeunit.al';
    const baseSub = {
      owner: { kind: 'codeunit', name: 'My Codeunit' },
      target: { kind: 'codeunit', name: 'Sales-Post' },
      targetEvent: 'OnAfterPostSalesDoc',
      location: {
        uri: { fsPath: pathWithPipe, path: pathWithPipe },
        range: { start: { line: 19, character: 0 } } // lineOf returns line+1 = 20
      }
    };

    // First compute the OLD subKey (line 10) the panel would have stored
    // before the save. The driver below builds it from a stale stand-in
    // subscriber and we feed only that key into relocate.
    const staleSub = {
      ...baseSub,
      location: {
        uri: { fsPath: pathWithPipe, path: pathWithPipe },
        range: { start: { line: 9, character: 0 } } // lineOf = 10
      }
    };
    const staleKey = (new Function('s', `${fnPathOf}\n${fnLineOf}\n${fnSubKey}\nreturn subKey(s);`) as (s: unknown) => string)(staleSub);

    // Sanity: the stale key must not match the post-save subKey (different lines).
    const freshKey = (new Function('s', `${fnPathOf}\n${fnLineOf}\n${fnSubKey}\nreturn subKey(s);`) as (s: unknown) => string)(baseSub);
    assert.notStrictEqual(staleKey, freshKey,
      'precondition: a line-shifting save must change the subKey');

    // The fresh subscribers list (post-save) carries baseSub at line 20.
    // relocateSelectedSubKey must promote selectedSubKey from staleKey to freshKey.
    const result = driver([baseSub], staleKey);
    assert.strictEqual(result.selectedSubKey, freshKey,
      'relocateSelectedSubKey must recover the post-save subKey even when the path contains "|"');
  });

  test('applyToken clears objectIdentity when the app dropdown changes, not just the kind dropdown (defect 4)', () => {
    // The Kind dropdown and the App dropdown both invalidate a prior
    // identity selector — picking a different app makes the tree-revealed
    // `codeunit::"Sales-Post"` stale because Sales-Post may not exist in
    // the new app. Clearing keeps the dropdowns and the free-text search
    // logically consistent.
    const html = renderPanelHtml('nonce123');
    // The clear branch now covers both 'kind' and 'app' tokens.
    assert.ok(/tokenKey === 'kind' \|\| tokenKey === 'app'/.test(html)
        || /tokenKey === 'app' \|\| tokenKey === 'kind'/.test(html),
      'applyToken must clear objectIdentity for BOTH the kind and app token keys');
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

  test('webview posting {type:"gotoSubscriber"} dispatches even when range arrives in the underscore-shape that postMessage actually produces', () => {
    // Regression: structured-clone of vscode.Range over the webview boundary
    // strips the public `start`/`end` getters and leaves only the internal
    // `_start`/`_end` data slots. The handler used to read `loc.range.end.line`
    // and crash with `Cannot read properties of undefined (reading 'line')`.
    // Now the panel host just forwards whatever shape it received and the
    // command itself revives via reviveRange — the dispatch must succeed.
    patchCreate();
    patchExecute();
    const store = new EventIndexStore();
    try {
      openPanel(fakeContext, store);
      const fake = createCalls[0];
      const clonedLocation = {
        uri: { scheme: 'file', authority: '', path: '/workspace/MySub.al', query: '', fragment: '' },
        range: {
          _start: { line: 12, character: 4 },
          _end:   { line: 12, character: 4 }
        }
      };
      fake.fireReceive({ type: 'gotoSubscriber', subscriber: { location: clonedLocation } });

      const dispatched = executeCalls.find((c) => c.command === 'alEventLens.gotoSubscriber');
      assert.ok(dispatched,
        'gotoSubscriber must dispatch even when the cloned range has only _start/_end (no public getters)');
      assert.strictEqual(dispatched!.args[0], clonedLocation,
        'panel host must forward the cloned location verbatim — revival happens in the command body');
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

  test('postRevealObjectToPanel: emits AL-style identity selector (`<kind>::<name>`), no app filter, no selectKey', () => {
    patchCreate();
    const store = new EventIndexStore();
    try {
      openPanel(fakeContext, store);
      const fake = createCalls[0];
      const before = fake.posts.length;

      postRevealObjectToPanel({ kind: 'codeunit', name: 'MyCu' });

      assert.strictEqual(fake.posts.length, before + 1);
      const last = fake.posts[fake.posts.length - 1] as {
        type: string; search: string; selectKey?: string;
      };
      assert.strictEqual(last.type, 'reveal');
      // Names without spaces are emitted unquoted; no app: token; no kind: token.
      assert.strictEqual(last.search, 'codeunit::MyCu');
      assert.strictEqual(last.selectKey, undefined,
        'reveal-object without a publisher must not include a selectKey');
    } finally {
      store.dispose();
    }
  });

  test('postRevealObjectToPanel: object names with spaces are quoted inside the identity selector', () => {
    patchCreate();
    const store = new EventIndexStore();
    try {
      openPanel(fakeContext, store);
      const fake = createCalls[0];

      // Same object name in two different .app packages would surface together
      // under this filter (deliberate — no app filter is emitted), but the
      // assertion here is purely on the search string shape for names with
      // whitespace.
      postRevealObjectToPanel({ kind: 'table', name: 'Sales Header' });

      const last = fake.posts[fake.posts.length - 1] as { search: string };
      assert.strictEqual(last.search, 'table::"Sales Header"');
    } finally {
      store.dispose();
    }
  });

  test('postRevealObjectToPanel: with a selectPublisher, includes selectKey and updates getSelectedPublisher synchronously', () => {
    patchCreate();
    const store = new EventIndexStore();
    try {
      openPanel(fakeContext, store);
      const fake = createCalls[0];
      const pub = makePublisher('MyCu', 'OnAfterFoo');

      postRevealObjectToPanel(pub.owner, pub);

      const last = fake.posts[fake.posts.length - 1] as {
        type: string; search: string; selectKey: string;
      };
      assert.strictEqual(last.type, 'reveal');
      assert.strictEqual(last.search, 'codeunit::MyCu');
      // selectKey shape matches publisherKey() — case-insensitive triple.
      assert.strictEqual(last.selectKey, 'codeunit mycu onafterfoo');
      assert.strictEqual(getSelectedPublisher(), pub,
        'passing a selectPublisher must update the module-level selection cache');
    } finally {
      store.dispose();
    }
  });

  test('postRevealObjectToPanel: no-op when no panel is open', () => {
    // No patchCreate / openPanel — activePanel stays undefined.
    postRevealObjectToPanel({ kind: 'codeunit', name: 'X' });
    // Nothing to assert on a fake panel since one was never created; the test
    // passes if the call returns without throwing.
    assert.ok(true);
  });

  test('postRevealSubscriberToPanel after openPanel posts a {type:"revealSubscriber", subscriber} message', () => {
    patchCreate();
    const store = new EventIndexStore();
    try {
      openPanel(fakeContext, store);
      const fake = createCalls[0];
      const before = fake.posts.length;

      const sub = makeSubscriber('Sales-Post', 'OnAfterPostSalesDoc');
      postRevealSubscriberToPanel(sub);

      assert.strictEqual(fake.posts.length, before + 1,
        'postRevealSubscriberToPanel must post exactly one message');
      const last = fake.posts[fake.posts.length - 1] as {
        type: string; subscriber: Subscriber;
      };
      assert.strictEqual(last.type, 'revealSubscriber');
      assert.strictEqual(last.subscriber, sub,
        'subscriber payload must be the exact object passed in');
    } finally {
      store.dispose();
    }
  });

  test('postRevealSubscriberToPanel: no-op when no panel is open', () => {
    // No patchCreate / openPanel — activePanel stays undefined.
    postRevealSubscriberToPanel(makeSubscriber('X', 'Y'));
    assert.ok(true);
  });

  test('a store file-update posts an incremental fileUpdate message, not the full index', () => {
    patchCreate();
    const store = new EventIndexStore();
    try {
      openPanel(fakeContext, store);
      const fake = createCalls[0];
      const before = fake.posts.length;

      store.updateFile(
        vscode.Uri.parse('file:///workspace/A.al'),
        [makePublisher('A', 'OnA')],
        []
      );

      const posted = fake.posts.slice(before) as Array<{ type?: string }>;
      assert.ok(posted.some((m) => m.type === 'fileUpdate'),
        'a .al save must post a fileUpdate message');
      assert.ok(!posted.some((m) => m.type === 'index'),
        'a .al save must not re-post the full index');
    } finally {
      store.dispose();
    }
  });
});

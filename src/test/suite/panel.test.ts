import * as assert from 'assert';
import * as vscode from 'vscode';
import type { Publisher, Subscriber } from '../../al/types';
import type { EventIndex } from '../../index/indexer';
import { EventIndexStore } from '../../index/store';
import { getSelectedPublisher, openPanel, postRevealObjectToPanel, postRevealSubscriberToPanel, postSelectToPanel } from '../../ui/panel';
import { renderPanelHtml } from '../../ui/panelHtml';
import { SubscriberTreeDataProvider, type SubTreeNode } from '../../ui/subscriberTreeView';

// ─── Fake WebviewPanel ───────────────────────────────────────────────────

class FakePanel {
  public posts: unknown[] = [];
  /**
   * Same payloads as `posts`, round-tripped through JSON — the shape the real
   * webview receives. `Webview.postMessage` serializes via `JSON.stringify`,
   * so `Uri.toJSON` / `Range.toJSON` run: a `Uri`'s `fsPath` appears only when
   * its lazy `_fsPath` slot was already warm, and a `Range` arrives as the
   * two-element array `[start, end]`. Assert against this whenever the test
   * cares about the webview's view of a payload; `posts` keeps the live
   * objects so host-side forwarding identity can still be asserted.
   */
  public serializedPosts: unknown[] = [];
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
        self.serializedPosts.push(JSON.parse(JSON.stringify(msg)));
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

// ─── Webview-script harness ─────────────────────────────────────────────

// The panel's behavior lives as plain JS inside a TS string literal, so the
// only way to exercise it is to render the HTML, pull the inline <script>
// out, and evaluate the named helpers the test needs in a controlled scope.
const PANEL_SCRIPT: string = ((): string => {
  const html = renderPanelHtml('nonce123');
  // Sliced by index rather than matched with a `<script>…</script>` regex.
  // This is extraction from our own generated document, not sanitization of
  // untrusted HTML, and a tag regex trips CodeQL's js/bad-tag-filter — which
  // is right that no such regex covers every end-tag form a browser accepts
  // (`</script >`, `</script foo="bar">`, upper case). `renderPanelHtml`
  // emits exactly one `<script>` element, so indexOf is both simpler and
  // exact here.
  const openStart = html.indexOf('<script');
  assert.ok(openStart !== -1, 'inline <script> must be present in the rendered HTML');
  const openEnd = html.indexOf('>', openStart);
  assert.ok(openEnd !== -1, 'the inline <script> open tag must be terminated');
  const closeStart = html.indexOf('</script', openEnd);
  assert.ok(closeStart !== -1, 'the inline <script> element must be closed');
  return html.slice(openEnd + 1, closeStart);
})();

/**
 * Pluck a named function declaration out of the panel script. Extraction is by
 * brace-counting rather than regex since the bodies contain nested `{}` (e.g.
 * for-loops inside `relocateSelectedSubKey`); string literals are skipped so a
 * `}` inside one cannot unbalance the count.
 */
function extractFn(name: string): string {
  const script = PANEL_SCRIPT;
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

/** The webview's `subKey` / `subIdentityKey`, evaluated exactly as it defines them. */
function makeKeyFns(): {
  subKey: (s: unknown) => string;
  subIdentityKey: (s: unknown) => string;
} {
  const factory = new Function(
    `${extractFn('pathOf')}
     ${extractFn('lineOf')}
     ${extractFn('subKey')}
     ${extractFn('subIdentityKey')}
     return { subKey: subKey, subIdentityKey: subIdentityKey };`
  ) as () => { subKey: (s: unknown) => string; subIdentityKey: (s: unknown) => string };
  return factory();
}

/**
 * Drive `relocateSelectedSubKey` over a post-save `subscribers` array, in a
 * scope mirroring the webview's own let-bindings.
 */
function makeRelocateDriver(): (
  subs: unknown[],
  selectedSubKeyIn: string | null
) => { selectedSubKey: string | null; subKeyOf: string | null } {
  return new Function(
    'subscribers',
    'selectedSubKeyIn',
    `let selectedSubKey = selectedSubKeyIn;
       let subscribersBySubKey = new Map();
       ${extractFn('pathOf')}
       ${extractFn('lineOf')}
       ${extractFn('subKey')}
       ${extractFn('subIdentityKey')}
       subscribers.forEach(function (s) { subscribersBySubKey.set(subKey(s), s); });
       ${extractFn('relocateSelectedSubKey')}
       relocateSelectedSubKey();
       return { selectedSubKey: selectedSubKey, subKeyOf: subscribers.length ? subKey(subscribers[0]) : null };`
  ) as (subs: unknown[], k: string | null) => { selectedSubKey: string | null; subKeyOf: string | null };
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

  test('two successive openPanel renders embed distinct 32-char nonces from the alphabet (defect 5)', () => {
    // makeNonce now draws from crypto.getRandomValues (a CSPRNG global in
    // both the desktop and web extension hosts) rather than Math.random().
    // makeNonce isn't exported, so assert through the rendered HTML the panel
    // sets on its webview — shape + variability only, never randomness strength.
    patchCreate();
    const store = new EventIndexStore();
    function extractNonce(html: string): string {
      const m = /<script\b[^>]*nonce="([^"]+)"/.exec(html);
      assert.ok(m, 'rendered HTML must carry a nonce on the inline <script>');
      return m![1];
    }
    try {
      openPanel(fakeContext, store);
      const firstHtml = createCalls[0].panel.webview.html as string;
      const firstNonce = extractNonce(firstHtml);
      assert.ok(/^[A-Za-z0-9]{32}$/.test(firstNonce),
        `nonce must be 32 chars from the alphabet; got "${firstNonce}"`);
      // The same nonce must also appear in the CSP script-src directive.
      assert.ok(firstHtml.includes(`'nonce-${firstNonce}'`),
        'the CSP meta must reference the same nonce in script-src');

      // Close and reopen — the second panel must get a different nonce.
      createCalls[0].fireDispose();
      openPanel(fakeContext, store);
      const secondNonce = extractNonce(createCalls[1].panel.webview.html as string);
      assert.ok(/^[A-Za-z0-9]{32}$/.test(secondNonce),
        `second nonce must be 32 chars from the alphabet; got "${secondNonce}"`);
      assert.notStrictEqual(firstNonce, secondNonce,
        'a fresh panel must get a freshly generated nonce');
      // Dispose the second panel so activePanel doesn't leak into later tests.
      createCalls[1].fireDispose();
    } finally {
      restoreCreate();
      store.dispose();
    }
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

    const driver = makeRelocateDriver();
    const { subKey } = makeKeyFns();

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
    const staleKey = subKey(staleSub);

    // Sanity: the stale key must not match the post-save subKey (different lines).
    const freshKey = subKey(baseSub);
    assert.notStrictEqual(staleKey, freshKey,
      'precondition: a line-shifting save must change the subKey');

    // The fresh subscribers list (post-save) carries baseSub at line 20.
    // relocateSelectedSubKey must promote selectedSubKey from staleKey to freshKey.
    const result = driver([baseSub], staleKey);
    assert.strictEqual(result.selectedSubKey, freshKey,
      'relocateSelectedSubKey must recover the post-save subKey even when the path contains "|"');
  });

  test('subKey / subIdentityKey are identical whether or not the serialized Uri carries fsPath (issue #183)', () => {
    // `Uri.toJSON()` emits `fsPath` ONLY when the lazy `_fsPath` slot has
    // already been computed on that instance; `path` and `scheme` are always
    // emitted. The store hands one shared `Uri` instance to every consumer, and
    // `subscriberTreeView.ts` reads `loc.uri.fsPath` for a leaf tooltip — so the
    // very same subscriber serializes without `fsPath` in the `index` message
    // posted on panel open, and WITH it in a later `revealSubscriber` message.
    // Keying on `fsPath` therefore produced two different keys for one row and
    // Reveal Subscriber selected nothing.
    //
    // The two bags below are hand-written with a HARDCODED divergent `fsPath`
    // rather than derived from a real `vscode.Uri.fsPath`, deliberately:
    // `uriToFsPath` flips `/`→`\` and strips the leading slash only when
    // `isWindows`, so on Linux/macOS `fsPath === path` byte-for-byte and a
    // derived fixture would pass against the buggy code on two of the three CI
    // legs. Same portability trap documented at subscriberTreeView.test.ts:181.
    const { subKey, subIdentityKey } = makeKeyFns();

    const range = [{ line: 11, character: 0 }, { line: 11, character: 0 }];
    const identity = {
      owner: { kind: 'codeunit', name: 'My Sub' },
      target: { kind: 'codeunit', name: 'Sales-Post' },
      targetEvent: 'OnAfterPostSalesDoc',
      resolved: true
    };
    // Cold: nothing had touched `.fsPath` before this message was serialized.
    const cold = {
      ...identity,
      location: { uri: { $mid: 1, path: '/c:/ws/src/Foo.al', scheme: 'file' }, range }
    };
    // Warm: the Subscribers tree rendered a leaf tooltip first, so `_fsPath`
    // was populated on the shared instance and `toJSON` emitted it too.
    const warm = {
      ...identity,
      location: {
        uri: {
          $mid: 1,
          fsPath: 'c:\\ws\\src\\Foo.al',
          _sep: 1,
          path: '/c:/ws/src/Foo.al',
          scheme: 'file'
        },
        range
      }
    };

    // Precondition: the fixture really does model a divergent pair — true on
    // every platform because both strings are literals, not derived.
    assert.notStrictEqual(warm.location.uri.fsPath, warm.location.uri.path,
      'fixture precondition: the warm bag must carry an fsPath that differs from path');

    assert.strictEqual(subKey(cold), subKey(warm),
      'subKey must not change depending on whether the serialized Uri carried fsPath');
    assert.strictEqual(subIdentityKey(cold), subIdentityKey(warm),
      'subIdentityKey must not change depending on whether the serialized Uri carried fsPath');
    // And it must be the stable component that survives — `uri.path`, which is
    // byte-identical on Windows, Linux and macOS.
    assert.ok(subKey(cold).includes('/c:/ws/src/Foo.al'),
      `keys must be built from uri.path; got: ${JSON.stringify(subKey(cold))}`);
    assert.ok(!subKey(cold).includes('\\'),
      'keys must never contain a backslash-mangled fsPath component');
  });

  test('a fileUpdate relocates the selection even when the post-save payload serialized WITH fsPath (issue #183)', () => {
    // AC 3: the selection was computed from a cold (`fsPath`-less) `index`
    // payload; the post-save `fileUpdate` arrives after the tree warmed
    // `_fsPath`, so its entry carries the backslash form. Keyed on `fsPath` the
    // relocator's `subIdentityKey` comparison could never match and the
    // detail pane silently reset to "Select a subscriber."
    // Hand-built fixtures — platform-independent by construction.
    const driver = makeRelocateDriver();
    const { subKey } = makeKeyFns();

    const identity = {
      owner: { kind: 'codeunit', name: 'My Sub' },
      target: { kind: 'codeunit', name: 'Sales-Post' },
      targetEvent: 'OnAfterPostSalesDoc',
      resolved: true
    };
    const coldUri = { $mid: 1, path: '/c:/ws/src/Foo.al', scheme: 'file' };
    const warmUri = {
      $mid: 1, fsPath: 'c:\\ws\\src\\Foo.al', _sep: 1, path: '/c:/ws/src/Foo.al', scheme: 'file'
    };
    // Selected at line 10, from the cold `index` payload.
    const selectedCold = {
      ...identity,
      location: { uri: coldUri, range: [{ line: 9, character: 0 }, { line: 9, character: 0 }] }
    };
    // Same subscriber after a line-shifting save, from the warm `fileUpdate`.
    const freshWarm = {
      ...identity,
      location: { uri: warmUri, range: [{ line: 19, character: 0 }, { line: 19, character: 0 }] }
    };

    const staleKey = subKey(selectedCold);
    const freshKey = subKey(freshWarm);
    assert.notStrictEqual(staleKey, freshKey,
      'precondition: a line-shifting save must change the subKey');

    const result = driver([freshWarm], staleKey);
    assert.strictEqual(result.selectedSubKey, freshKey,
      'relocateSelectedSubKey must recover the selection across a cold→warm serialization flip');
  });

  test('displayPathOf derives a native-looking path from uri.path alone, honoring the al-eventlens-app: guard (issue #183)', () => {
    // Keys are now `uri.path`-only, so display can no longer read `fsPath`
    // either — it is present in only some payloads. `displayPathOf` reproduces
    // what `Uri.fsPath` would have shown, deterministically, so the panel's
    // path column stops flipping between the two forms.
    //
    // `uriToFsPath` has TWO branches that diverge from `uri.path`: the `file:`
    // drive-letter path, covered here, and the authority-bearing `file:` URI
    // (UNC), covered by the test below. Every fixture is a HAND-WRITTEN
    // literal, never derived from a real `vscode.Uri` — `fsPath === path`
    // byte-for-byte on Linux and macOS (the separator rewrite is
    // `isWindows`-gated), so a derived fixture would pass against buggy code on
    // two of the three CI legs. Same reasoning as
    // subscriberTreeView.test.ts:181-184.
    const displayPathOf = new Function(
      'loc',
      `${extractFn('pathOf')}
       ${extractFn('displayPathOf')}
       return displayPathOf(loc);`
    ) as (loc: unknown) => string | null;

    assert.strictEqual(
      displayPathOf({ uri: { scheme: 'file', path: '/c:/ws/src/Foo.al' } }),
      'c:\\ws\\src\\Foo.al',
      'a file: drive-letter path must render in native Windows form');
    assert.strictEqual(
      displayPathOf({ uri: { scheme: 'file', path: '/home/u/src/Foo.al' } }),
      '/home/u/src/Foo.al',
      'a POSIX file: path must render unchanged');

    // #132: subscribers parsed from a packaged .app carry the synthetic
    // `al-eventlens-app:` scheme; its path must stay clean forward-slash.
    const synthetic = displayPathOf({
      uri: { scheme: 'al-eventlens-app', path: '/Some.AppId/src/Foo.al' }
    });
    assert.strictEqual(synthetic, '/Some.AppId/src/Foo.al',
      'the synthetic scheme must keep its clean forward-slash path');
    assert.ok(!synthetic!.includes('\\'),
      'the synthetic scheme must never be backslash-mangled');

    assert.strictEqual(displayPathOf(null), null,
      'a missing location must yield null, matching pathOf');
  });

  test('displayPathOf keeps the authority of a UNC file: URI instead of truncating to uri.path (issue #183 review)', () => {
    // The second `uriToFsPath` divergence branch. `Uri.parse(
    // "file://server/share/Foo.al")` yields authority `server` + path
    // `/share/Foo.al`, and `uriToFsPath` takes its FIRST branch —
    // `//${authority}${path}` — which the isWindows rewrite then turns into
    // `\\server\share\Foo.al` (the rewrite trails the whole ternary via the
    // comma operator, so it applies to this branch too).
    //
    // Reading `uri.path` alone drops the server name entirely, rendering
    // `/share/Foo.al`: not copy-pasteable, and ambiguous between two servers
    // hosting the same share name.
    //
    // Fixtures are hand-written literals for the same portability reason as the
    // test above — a UNC fixture derived from a real `vscode.Uri` would diverge
    // on POSIX too, but only because `fsPath` there is `//server/share/Foo.al`,
    // which is a different assertion than the one that matters.
    const displayPathOf = new Function(
      'loc',
      `${extractFn('pathOf')}
       ${extractFn('displayPathOf')}
       return displayPathOf(loc);`
    ) as (loc: unknown) => string | null;

    const unc = displayPathOf({
      uri: { scheme: 'file', authority: 'server', path: '/share/Foo.al' }
    });
    assert.strictEqual(unc, '\\\\server\\share\\Foo.al',
      'a UNC file: URI must render with its authority, not truncated to the path');
    assert.ok(unc!.includes('server'),
      'the UNC server name must never be dropped from the displayed path');

    // The authority branch must be tested BEFORE the drive-letter branch, as
    // upstream does — an administrative share is a share, not a local drive.
    assert.strictEqual(
      displayPathOf({ uri: { scheme: 'file', authority: 'server', path: '/c$/ws/Foo.al' } }),
      '\\\\server\\c$\\ws\\Foo.al',
      'an administrative-share UNC path must keep its authority');

    // `p.length > 1` mirrors uriToFsPath's own guard: an authority with a bare
    // `/` path is not a UNC path.
    assert.strictEqual(
      displayPathOf({ uri: { scheme: 'file', authority: 'server', path: '/' } }),
      '/',
      'an authority with a one-character path must not take the UNC branch');

    // An authority on a non-`file:` scheme must not trigger UNC rendering — the
    // scheme guard that protects the synthetic `al-eventlens-app:` scheme
    // (#132) has to hold for authority-bearing URIs as well.
    const remote = displayPathOf({
      uri: { scheme: 'vscode-remote', authority: 'wsl+ubuntu', path: '/home/u/src/Foo.al' }
    });
    assert.strictEqual(remote, '/home/u/src/Foo.al',
      'a non-file: scheme with an authority must render its plain path');
    assert.ok(!remote!.includes('\\'),
      'a non-file: scheme must never be backslash-mangled');
  });

  test('lineOf reads the two-element array shape that Range.toJSON actually produces (issue #183)', () => {
    // `Range.toJSON()` returns `[start, end]`, so a real postMessage payload
    // has neither `.start` nor `._start` — `lineOf` returned 0 for every row in
    // the shipped product (paths read `:0`, and subKey's line component was a
    // constant, which also made relocateSelectedSubKey a no-op).
    const lineOf = new Function('loc', `${extractFn('lineOf')}\nreturn lineOf(loc);`) as
      (loc: unknown) => number;

    assert.strictEqual(
      lineOf({ range: [{ line: 11, character: 0 }, { line: 11, character: 4 }] }), 12,
      'the serialized array shape must yield the 1-based start line');
    // The pre-existing shapes stay supported.
    assert.strictEqual(lineOf({ range: { start: { line: 4, character: 0 } } }), 5,
      'the plain {start:{line}} shape must still work');
    assert.strictEqual(lineOf({ range: { _start: { _line: 6 } } }), 7,
      'the structured-clone {_start:{_line}} shape must still work');
    assert.strictEqual(lineOf({}), 0, 'a location with no range yields 0');
    assert.strictEqual(lineOf(null), 0, 'a missing location yields 0');
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
    // (Fixture is the hybrid outer-slots/inner-public-names shape; genuine
    // structuredClone nests `_line`/`_character` too. Revival of both lives
    // in reviveLocation.test.ts — this test only proves the panel forwards
    // whatever shape it received.)
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

  test('repeated open/close does not accumulate panel disposables in context.subscriptions (defect 1)', () => {
    // openPanel no longer pushes the WebviewPanel into context.subscriptions —
    // its lifecycle is fully managed by onDidDispose + the activePanel guard.
    // Use a dedicated context so the shared fakeContext isn't polluted.
    patchCreate();
    const localContext = {
      subscriptions: [] as vscode.Disposable[],
      extension: { id: 'dvlprlife.al-eventlens' }
    } as unknown as vscode.ExtensionContext;
    const store = new EventIndexStore();
    try {
      assert.strictEqual(localContext.subscriptions.length, 0,
        'precondition: subscriptions starts empty');

      // Open / close three cycles.
      for (let i = 0; i < 3; i++) {
        openPanel(localContext, store);
        createCalls[createCalls.length - 1].fireDispose();
      }

      assert.strictEqual(localContext.subscriptions.length, 0,
        'openPanel must not push the panel into context.subscriptions on any cycle');
    } finally {
      restoreCreate();
      store.dispose();
    }
  });

  test('a full re-index (onDidChange) clears the cached selection; an incremental save (onDidUpdateFile) does not (defect 4)', () => {
    patchCreate();
    const store = new EventIndexStore();
    try {
      openPanel(fakeContext, store);
      const fake = createCalls[0];

      // Select a publisher via the webview round-trip.
      const pub = makePublisher('Sales-Post', 'OnAfterPostSalesDoc');
      fake.fireReceive({ type: 'selectionChanged', publisher: pub });
      assert.strictEqual(getSelectedPublisher(), pub,
        'precondition: selection is set after selectionChanged');

      // An incremental save (onDidUpdateFile) preserves the selection by design.
      store.updateFile(
        vscode.Uri.parse('file:///workspace/Other.al'),
        [makePublisher('Other', 'OnOther')],
        []
      );
      assert.strictEqual(getSelectedPublisher(), pub,
        'incremental save must NOT clear the cached selection');

      // A full re-index (onDidChange via store.set) clears the selection so
      // Export Mermaid from the palette can no longer export a dropped publisher.
      store.set({
        publishers: [makePublisher('Brand New', 'OnFresh')],
        subscribers: [],
        appMeta: new Map()
      });
      assert.strictEqual(getSelectedPublisher(), undefined,
        'full re-index must clear the cached selection');
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
      // selectKey shape matches publisherKey() — case-insensitive triple,
      // U+0001-delimited (issue #133; previously a single space).
      assert.strictEqual(last.selectKey, 'codeunit\x01mycu\x01onafterfoo');
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

  test('the index and revealSubscriber payloads key to the same row after the tree warms Uri._fsPath (issue #183, AC 1)', () => {
    // End-to-end reproduction, in the order a user hits it:
    //   1. panel opens  → `index` posted while `_fsPath` is still cold
    //   2. Subscribers tree renders a leaf tooltip → reads `loc.uri.fsPath`,
    //      populating the lazy slot on the shared Uri instance
    //   3. leaf click    → `revealSubscriber` posted, now WITH `fsPath`
    // Both payloads must produce the same `subKey` or the reveal handler's
    // `subscribersBySubKey` lookup misses and the panel selects nothing.
    //
    // NOTE: this scenario is tautological on Linux/macOS — `uriToFsPath` only
    // diverges from `path` when `isWindows`, so the two payloads are identical
    // there regardless of the fix. The portable guard is the hand-built
    // fixture test in the renderPanelHtml suite above; this one proves the
    // real host wiring reaches that state on Windows.
    patchCreate();
    const store = new EventIndexStore();
    try {
      const sub: Subscriber = {
        owner: { kind: 'codeunit', name: 'My Sub' },
        target: { kind: 'codeunit', name: 'Sales-Post' },
        targetEvent: 'OnAfterPostSalesDoc',
        // Fresh instance, never read through `.fsPath` by this test before the
        // tree does — that is the whole point.
        location: new vscode.Location(
          vscode.Uri.parse('file:///c:/ws/src/Foo.al'),
          new vscode.Position(11, 0)
        ),
        resolved: true
      };
      store.set({ publishers: [], subscribers: [sub], appMeta: new Map() });

      openPanel(fakeContext, store);
      const fake = createCalls[0];
      const indexPost = fake.serializedPosts[0] as {
        type: string;
        subscribers: Array<{ location: { uri: { fsPath?: string; path: string } } }>;
      };
      assert.strictEqual(indexPost.type, 'index');
      assert.strictEqual(indexPost.subscribers.length, 1);

      // Render the tree leaf — `getTreeItem` builds the tooltip from
      // `loc.uri.fsPath`, warming `_fsPath` on the shared Uri instance.
      const provider = new SubscriberTreeDataProvider(store);
      const [appNode] = provider.getChildren() as SubTreeNode[];
      const [kindNode] = provider.getChildren(appNode) as SubTreeNode[];
      const [objectNode] = provider.getChildren(kindNode) as SubTreeNode[];
      const [leaf] = provider.getChildren(objectNode) as SubTreeNode[];
      provider.getTreeItem(leaf);

      postRevealSubscriberToPanel(sub);
      const revealPost = fake.serializedPosts[fake.serializedPosts.length - 1] as {
        type: string;
        subscriber: { location: { uri: { fsPath?: string; path: string } } };
      };
      assert.strictEqual(revealPost.type, 'revealSubscriber');

      if (process.platform === 'win32') {
        // Guard that the scenario is genuinely exercised here: the scenario is
        // the cold→warm transition, so BOTH ends must be pinned. Asserting only
        // that the warmed payload diverges leaves the test able to go vacuous
        // in silence — if some future read of `.fsPath` inside openPanel or the
        // store warms `_fsPath` before the `index` post, both payloads would
        // carry the same fsPath, the key equality below would hold trivially,
        // and this guard would stay green.
        assert.strictEqual(indexPost.subscribers[0].location.uri.fsPath, undefined,
          'precondition (win32): the index payload must be serialized before _fsPath is warmed');
        const revealUri = revealPost.subscriber.location.uri;
        assert.ok(typeof revealUri.fsPath === 'string' && revealUri.fsPath.length > 0,
          'precondition (win32): the post-tree reveal payload must carry a serialized fsPath');
        assert.notStrictEqual(revealUri.fsPath, revealUri.path,
          'precondition (win32): the serialized fsPath must differ from uri.path');
      }

      const { subKey } = makeKeyFns();
      assert.strictEqual(
        subKey(revealPost.subscriber),
        subKey(indexPost.subscribers[0]),
        'the revealSubscriber payload must key to the same row as the index payload');
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

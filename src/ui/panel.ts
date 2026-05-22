import * as vscode from 'vscode';
import type { ObjectRef, Publisher, Subscriber } from '../al/types';
import { publisherKey } from '../index/match';
import { EventIndexStore } from '../index/store';
import { renderPanelHtml } from './panelHtml';

let activePanel: vscode.WebviewPanel | undefined;
let storeListener: vscode.Disposable | undefined;
let selectedPublisher: Publisher | undefined;

const NONCE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

function makeNonce(): string {
  let out = '';
  for (let i = 0; i < 32; i++) {
    out += NONCE_ALPHABET.charAt(Math.floor(Math.random() * NONCE_ALPHABET.length));
  }
  return out;
}

/**
 * Create or focus the AL EventLens webview panel — the searchable
 * publisher list plus subscriber detail view. The panel posts
 * `gotoSubscriber` / `refresh` messages back to the extension host
 * when items are clicked.
 */
export function openPanel(context: vscode.ExtensionContext, store: EventIndexStore): void {
  if (activePanel) {
    activePanel.reveal(activePanel.viewColumn ?? vscode.ViewColumn.Beside);
    return;
  }

  const nonce = makeNonce();
  const panel = vscode.window.createWebviewPanel(
    'alEventLens.panel',
    'AL EventLens',
    vscode.ViewColumn.Beside,
    { enableScripts: true, retainContextWhenHidden: true }
  );
  panel.webview.html = renderPanelHtml(nonce);

  const initial = store.get();
  void panel.webview.postMessage({
    type: 'index',
    publishers: initial.publishers,
    subscribers: initial.subscribers,
    appMeta: Array.from(initial.appMeta.entries())
  });

  storeListener = store.onDidChange((idx) => {
    void panel.webview.postMessage({
      type: 'index',
      publishers: idx.publishers,
      subscribers: idx.subscribers,
      appMeta: Array.from(idx.appMeta.entries())
    });
  });

  panel.webview.onDidReceiveMessage(
    (msg: {
      type?: string;
      subscriber?: { location?: vscode.Location };
      publisher?: Publisher | null;
    }) => {
      if (msg?.type === 'gotoSubscriber' && msg.subscriber?.location) {
        void vscode.commands.executeCommand('alEventLens.gotoSubscriber', msg.subscriber.location);
      } else if (msg?.type === 'refresh') {
        void vscode.commands.executeCommand('alEventLens.refresh');
      } else if (msg?.type === 'selectionChanged') {
        selectedPublisher = msg.publisher ?? undefined;
      }
    }
  );

  panel.onDidDispose(() => {
    activePanel = undefined;
    selectedPublisher = undefined;
    storeListener?.dispose();
    storeListener = undefined;
  });

  activePanel = panel;
  context.subscriptions.push(panel);
}

/**
 * Post a `{type:'select', publisher}` message to the active panel, if any.
 * Used by `alEventLens.revealPublisher` after `openPanel` returns so the
 * panel highlights the publisher emitted by the tree leaf or CodeLens.
 *
 * Also updates the module-level selection cache so a follow-up
 * `getSelectedPublisher()` (e.g. `exportMermaid` from the command palette)
 * sees the new selection without waiting for the webview's own
 * `selectionChanged` round-trip.
 */
export function postSelectToPanel(publisher: Publisher): void {
  if (activePanel) {
    selectedPublisher = publisher;
    void activePanel.webview.postMessage({ type: 'select', publisher });
  }
}

/**
 * Post a `{type:'reveal', search, selectKey?}` message to the active panel,
 * if any. Used to drive the panel from external triggers (tree-view clicks,
 * CodeLens) — sets the search box to an AL-style identity selector
 * (`Codeunit::"Sales-Post"`) so the panel filters to just the supplied
 * object's events, then optionally selects the supplied publisher inside
 * the filtered view.
 *
 * The owning app is intentionally NOT part of the filter — same-named
 * objects across multiple apps (e.g. BaseApp + an extension) surface
 * together rather than fragmenting into per-app filtered views.
 */
export function postRevealObjectToPanel(
  owner: Pick<ObjectRef, 'kind' | 'name'>,
  selectPublisher?: Publisher
): void {
  if (!activePanel) {
    return;
  }
  const search = buildObjectSearch(owner);
  const selectKey = selectPublisher ? publisherKey(selectPublisher) : undefined;
  if (selectPublisher) {
    selectedPublisher = selectPublisher;
  }
  void activePanel.webview.postMessage({ type: 'reveal', search, selectKey });
}

/**
 * Post a `{type:'revealSubscriber', subscriber}` message to the active
 * panel, if any. Used by `alEventLens.revealSubscriber` after `openPanel`
 * returns so the panel switches to Subscribers mode and selects the
 * subscriber emitted by a Subscribers-tree leaf.
 *
 * The webview already receives the full `subscribers` array via the
 * `index` message, so no extra data is sent — the webview matches this
 * subscriber against that list by a clone-safe key.
 */
export function postRevealSubscriberToPanel(subscriber: Subscriber): void {
  if (activePanel) {
    void activePanel.webview.postMessage({ type: 'revealSubscriber', subscriber });
  }
}

function buildObjectSearch(owner: Pick<ObjectRef, 'kind' | 'name'>): string {
  // AL-style identity selector — e.g. `Codeunit::"Sales-Post"`. The kind is
  // implicit in the selector, and the appId is intentionally omitted so the
  // same object name spotted across multiple apps (BaseApp + an extension)
  // surfaces together rather than splitting into separate filtered views.
  const namePart = /[\s"]/.test(owner.name)
    ? `"${owner.name.replace(/"/g, '')}"`
    : owner.name;
  return `${owner.kind}::${namePart}`;
}

/**
 * Current panel selection, or `undefined` when the panel is closed or no
 * publisher has been clicked. The export-Mermaid command falls back to
 * this when invoked from the command palette without an arg.
 */
export function getSelectedPublisher(): Publisher | undefined {
  return selectedPublisher;
}

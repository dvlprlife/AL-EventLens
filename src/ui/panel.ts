import * as vscode from 'vscode';
import type { Publisher } from '../al/types';
import { EventIndexStore } from '../index/store';
import { renderPanelHtml } from './panelHtml';

let activePanel: vscode.WebviewPanel | undefined;
let storeListener: vscode.Disposable | undefined;

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
    subscribers: initial.subscribers
  });

  storeListener = store.onDidChange((idx) => {
    void panel.webview.postMessage({
      type: 'index',
      publishers: idx.publishers,
      subscribers: idx.subscribers
    });
  });

  panel.webview.onDidReceiveMessage(
    (msg: { type?: string; subscriber?: { location?: vscode.Location } }) => {
      if (msg?.type === 'gotoSubscriber' && msg.subscriber?.location) {
        void vscode.commands.executeCommand('alEventLens.gotoSubscriber', msg.subscriber.location);
      } else if (msg?.type === 'refresh') {
        void vscode.commands.executeCommand('alEventLens.refresh');
      }
    }
  );

  panel.onDidDispose(() => {
    activePanel = undefined;
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
 */
export function postSelectToPanel(publisher: Publisher): void {
  if (activePanel) {
    void activePanel.webview.postMessage({ type: 'select', publisher });
  }
}

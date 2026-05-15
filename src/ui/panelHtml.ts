/**
 * Return the full HTML document for the AL EventLens webview panel.
 * The returned string includes inline CSS and JS — the panel is a single
 * self-contained document with no external resources, so it works
 * identically on desktop and VS Code Web.
 */
export function renderPanelHtml(nonce: string): string {
  throw new Error(`renderPanelHtml(nonce=${nonce}): not yet implemented`);
}

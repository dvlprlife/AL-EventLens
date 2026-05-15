import * as vscode from 'vscode';

/**
 * Return the workspace-folder-relative POSIX path for a URI, or the URI's
 * `path` segment when the URI lies outside any workspace folder.
 */
export function workspaceRelativePath(uri: vscode.Uri): string {
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  if (!folder) {
    return uri.path;
  }
  const folderPath = folder.uri.path;
  if (uri.path === folderPath) {
    return '';
  }
  if (uri.path.startsWith(folderPath + '/')) {
    return uri.path.slice(folderPath.length + 1);
  }
  return uri.path;
}

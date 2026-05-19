import * as vscode from 'vscode';

/**
 * One workspace AL project, identified by its `app.json` manifest.
 *
 * `appId` is the raw `id` GUID exactly as it appears in `app.json` — casing is
 * preserved here so the value can be used directly as an `owner.appId` (the
 * tree groups by it). Callers that need to compare an `appId` against a `.app`
 * package's `NavxManifest.xml` GUID (whose casing varies) must lowercase both
 * sides themselves.
 */
export interface WorkspaceApp {
  /** Raw `id` GUID from `app.json`. */
  readonly appId: string;
  /** `name` from `app.json`, when present. */
  readonly name?: string;
  /** `publisher` from `app.json`, when present. Named `appPublisher` (not
   *  `publisher`) to match `AppMeta` and avoid colliding with the AL EventLens
   *  domain concept of an *event publisher*. */
  readonly appPublisher?: string;
  /** Directory that contains the `app.json` — the project root. */
  readonly dir: vscode.Uri;
}

/**
 * Discover every workspace AL project by locating its `app.json` manifest.
 *
 * Walks every `app.json` (excluding `node_modules`), reads each via
 * `vscode.workspace.fs` (VS Code Web compatible — no Node `fs`), and parses
 * out the `id` / `name` / `publisher` fields. A malformed or non-AL
 * `app.json` (e.g. a tooling manifest that is not a Business Central app
 * manifest) is tolerated the same way the `.app` loop tolerates a corrupt
 * package — `console.warn` + skip — so one bad file never aborts discovery.
 *
 * Entries with no usable string `id` are skipped. An empty result is a
 * valid, expected state (a workspace with no AL project open).
 */
export async function discoverWorkspaceApps(): Promise<WorkspaceApp[]> {
  const uris = await vscode.workspace.findFiles('**/app.json', '**/node_modules/**');
  const decoder = new TextDecoder('utf-8');
  const apps: WorkspaceApp[] = [];
  for (const uri of uris) {
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      const json = JSON.parse(decoder.decode(bytes)) as unknown;
      if (typeof json !== 'object' || json === null) {
        continue;
      }
      const manifest = json as { id?: unknown; name?: unknown; publisher?: unknown };
      if (typeof manifest.id !== 'string' || manifest.id.length === 0) {
        continue;
      }
      apps.push({
        appId: manifest.id,
        name: typeof manifest.name === 'string' ? manifest.name : undefined,
        appPublisher: typeof manifest.publisher === 'string' ? manifest.publisher : undefined,
        dir: dirOf(uri)
      });
    } catch (err) {
      console.warn(`AL EventLens: failed to read app.json from ${uri.fsPath}: ${err}`);
      continue;
    }
  }
  return apps;
}

/**
 * Attribute a workspace file to the AL project that owns it: the project
 * whose `dir` is the nearest (longest path-prefix) enclosing directory of
 * `fileUri`. Returns the project's `appId`, or `undefined` when the file
 * lies under no `app.json` project (a loose `.al` file).
 *
 * Longest-prefix wins so nested projects (`root/app.json` plus
 * `root/sub/app.json`) resolve deterministically to the innermost project.
 */
export function attributeToApp(
  fileUri: vscode.Uri,
  apps: ReadonlyArray<WorkspaceApp>
): string | undefined {
  let best: WorkspaceApp | undefined;
  let bestLen = -1;
  for (const app of apps) {
    if (!isUnder(fileUri, app.dir)) {
      continue;
    }
    if (app.dir.path.length > bestLen) {
      best = app;
      bestLen = app.dir.path.length;
    }
  }
  return best?.appId;
}

/** True when `fileUri` lives inside (or directly at) the directory `dir`,
 *  comparing the same `scheme` + `authority` and POSIX `path` segments. */
function isUnder(fileUri: vscode.Uri, dir: vscode.Uri): boolean {
  if (fileUri.scheme !== dir.scheme || fileUri.authority !== dir.authority) {
    return false;
  }
  if (fileUri.path === dir.path) {
    return true;
  }
  const prefix = dir.path.endsWith('/') ? dir.path : dir.path + '/';
  return fileUri.path.startsWith(prefix);
}

/** Return the URI of the directory containing `uri`, using POSIX path
 *  arithmetic (no Node `path` — keeps the module VS Code Web compatible). */
function dirOf(uri: vscode.Uri): vscode.Uri {
  const slash = uri.path.lastIndexOf('/');
  const dirPath = slash <= 0 ? '/' : uri.path.slice(0, slash);
  return uri.with({ path: dirPath });
}

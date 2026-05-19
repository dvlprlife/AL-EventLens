import * as vscode from 'vscode';
import JSZip from 'jszip';

/** Raw bytes of a `SymbolReference.json` extracted from a `.app` package. */
export interface AppContents {
  readonly appId: string;
  readonly version: string;
  /** Friendly app name from `NavxManifest.xml`'s `<App Name="..."` attribute, when present. */
  readonly name?: string;
  /** App vendor from `NavxManifest.xml`'s `<App Publisher="..."` attribute, when present.
   *  Named `appPublisher` (not `publisher`) to avoid colliding with the AL EventLens
   *  domain concept of an *event publisher*. */
  readonly appPublisher?: string;
  readonly symbolReferenceJson: string;
  /** Bundled AL source files when the package included them under `src/**`. */
  readonly bundledAlSources: ReadonlyArray<{ path: string; text: string }>;
}

/** Subset of `AppContents` exposing only the `NavxManifest.xml`-derived
 *  identity fields. Cheap to read because it avoids decompressing
 *  `SymbolReference.json` (large) and any bundled `src` AL files. Used
 *  by the indexer's dedupe pass to group `.app` files by `appId` before
 *  paying the full-parse cost on losers. */
export interface AppMetadata {
  readonly appId: string;
  readonly version: string;
  readonly name?: string;
  readonly appPublisher?: string;
}

const NAVX_HEADER_SIZE = 40;
const NAVX_MAGIC = [0x4E, 0x41, 0x56, 0x58]; // "NAVX"

/**
 * Read a Business Central `.app` package via `vscode.workspace.fs` and
 * return its parseable contents.
 *
 * The format is a 40-byte **NAVX** header followed by a standard PKZIP
 * archive. The header is stripped and the remainder is decompressed with
 * JSZip (a browser-compatible zip library, required by the VS Code Web
 * runtime).
 *
 * `.NEA` runtime packages are encrypted and unreadable; callers that hand
 * a `.NEA` to this function will receive a clear error rather than a
 * silent failure.
 */
export async function readApp(uri: vscode.Uri): Promise<AppContents> {
  if (uri.path.toLowerCase().endsWith('.nea')) {
    throw new Error(
      `readApp: .NEA runtime packages are encrypted and unsupported (uri=${uri.toString()})`
    );
  }
  const bytes = await vscode.workspace.fs.readFile(uri);
  return parseAppBytes(bytes, uri.toString());
}

/**
 * Read just the `NavxManifest.xml` identity fields (`appId`, `version`,
 * optional `name`, optional `appPublisher`) from a `.app` package. Skips the
 * `SymbolReference.json` decompression and the bundled-source walk — useful
 * for the indexer's multi-version dedupe pass where we need to pick the
 * highest-version winner per `appId` before paying the full-parse cost.
 *
 * Same error contract as `readApp`: rejects `.NEA` runtime packages with a
 * clear message rather than silently failing.
 */
export async function readAppMetadata(uri: vscode.Uri): Promise<AppMetadata> {
  if (uri.path.toLowerCase().endsWith('.nea')) {
    throw new Error(
      `readAppMetadata: .NEA runtime packages are encrypted and unsupported (uri=${uri.toString()})`
    );
  }
  const bytes = await vscode.workspace.fs.readFile(uri);
  return parseAppMetadataBytes(bytes, uri.toString());
}

/**
 * Parse already-loaded `.app` bytes for manifest-only identity fields.
 * Exported for testability and so callers that already have the bytes
 * in hand (e.g. test fixtures) can avoid the I/O round-trip.
 */
export async function parseAppMetadataBytes(
  bytes: Uint8Array,
  sourceLabel: string
): Promise<AppMetadata> {
  const zip = await openNavxZip(bytes, sourceLabel, 'readAppMetadata');
  return readManifest(zip, sourceLabel, 'readAppMetadata');
}

/**
 * Parse already-loaded `.app` bytes. Exported for testability so unit
 * tests can construct fake packages in memory via JSZip without touching
 * the filesystem.
 */
export async function parseAppBytes(
  bytes: Uint8Array,
  sourceLabel: string
): Promise<AppContents> {
  const zip = await openNavxZip(bytes, sourceLabel, 'readApp');
  const { appId, version, name, appPublisher } = await readManifest(zip, sourceLabel, 'readApp');

  const symbolEntry = zip.file('SymbolReference.json');
  if (!symbolEntry) {
    throw new Error(
      `readApp: SymbolReference.json not found inside .app package (source=${sourceLabel})`
    );
  }
  const symbolReferenceJson = await symbolEntry.async('string');

  const bundledAlSources: { path: string; text: string }[] = [];
  for (const [path, entry] of Object.entries(zip.files)) {
    if (entry.dir) {
      continue;
    }
    if (!isBundledAlSource(path)) {
      continue;
    }
    bundledAlSources.push({ path, text: await entry.async('string') });
  }

  return { appId, version, name, appPublisher, symbolReferenceJson, bundledAlSources };
}

async function openNavxZip(
  bytes: Uint8Array,
  sourceLabel: string,
  caller: string
): Promise<JSZip> {
  if (bytes.length < NAVX_HEADER_SIZE) {
    throw new Error(
      `${caller}: file too small to be a .app package (source=${sourceLabel}, ${bytes.length} bytes)`
    );
  }
  for (let i = 0; i < NAVX_MAGIC.length; i++) {
    if (bytes[i] !== NAVX_MAGIC[i]) {
      throw new Error(
        `${caller}: not a NAVX-formatted .app package; check whether the file is a .NEA runtime package or corrupt (source=${sourceLabel})`
      );
    }
  }
  const zipBytes = bytes.slice(NAVX_HEADER_SIZE);
  return JSZip.loadAsync(zipBytes);
}

async function readManifest(
  zip: JSZip,
  sourceLabel: string,
  caller: string
): Promise<AppMetadata> {
  const manifestEntry = zip.file('NavxManifest.xml');
  if (!manifestEntry) {
    throw new Error(
      `${caller}: NavxManifest.xml not found inside .app package (source=${sourceLabel})`
    );
  }
  const manifestXml = await manifestEntry.async('string');
  return parseManifest(manifestXml, sourceLabel);
}

function isBundledAlSource(path: string): boolean {
  const lower = path.toLowerCase();
  return lower.startsWith('src/') && lower.endsWith('.al');
}

function parseManifest(
  xml: string,
  sourceLabel: string
): { appId: string; version: string; name?: string; appPublisher?: string } {
  const appElement = /<App\b[^>]*>/i.exec(xml);
  if (!appElement) {
    throw new Error(
      `readApp: <App> element not found in NavxManifest.xml (source=${sourceLabel})`
    );
  }
  const idMatch = /\bId\s*=\s*"([^"]+)"/i.exec(appElement[0]);
  const versionMatch = /\bVersion\s*=\s*"([^"]+)"/i.exec(appElement[0]);
  if (!idMatch || !versionMatch) {
    throw new Error(
      `readApp: NavxManifest.xml <App> element missing Id or Version attribute (source=${sourceLabel})`
    );
  }
  const nameMatch = /\bName\s*=\s*"([^"]+)"/i.exec(appElement[0]);
  const publisherMatch = /\bPublisher\s*=\s*"([^"]+)"/i.exec(appElement[0]);
  return {
    appId: idMatch[1],
    version: versionMatch[1],
    name: nameMatch?.[1],
    appPublisher: publisherMatch?.[1]
  };
}

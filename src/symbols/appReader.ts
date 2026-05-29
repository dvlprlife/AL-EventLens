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

// Decompression caps. A `.app` is a PKZIP archive; the zip central directory
// declares each entry's uncompressed size, so a few-KB crafted package can
// claim multi-GB entries that would OOM/hang the extension host once inflated.
// We read the declared size before inflating and refuse to materialize any
// entry, total, or count that exceeds these bounds. They are generous enough
// that no legitimate `.app` (including the full Microsoft BaseApp, whose
// `SymbolReference.json` is in the low tens of MB) trips them.
const MAX_ENTRY_UNCOMPRESSED_BYTES = 256 * 1024 * 1024; // 256 MB per entry
const MAX_TOTAL_UNCOMPRESSED_BYTES = 512 * 1024 * 1024; // 512 MB per package
const MAX_BUNDLED_ENTRY_COUNT = 50_000; // bundled src/**/*.al entry count

/**
 * Overridable decompression bounds for `parseAppBytes`. Production callers omit
 * this and get the module defaults above; tests inject small values to exercise
 * the cap logic without materializing huge inputs (50k entries / hundreds of MB).
 */
export interface DecompressionLimits {
  /** Per-entry declared-uncompressed-size cap, in bytes. */
  readonly maxEntryBytes?: number;
  /** Cumulative declared-uncompressed-size cap across all read entries, in bytes. */
  readonly maxTotalBytes?: number;
  /** Maximum number of bundled AL source entries (the `src/` `.al` files). */
  readonly maxEntryCount?: number;
}

/**
 * Read the declared uncompressed size of a loaded zip entry from JSZip's
 * private `_data` (a `CompressedObject`) without resorting to `any`
 * (`@typescript-eslint/no-explicit-any` is an error in this repo). JSZip 3.x
 * populates this field straight from the zip central directory at
 * `loadAsync` time — before any inflation — so callers can bound work before
 * materializing the entry. The shape is documented (commented out) in jszip's
 * own `index.d.ts`.
 *
 * Read defensively: returns `undefined` when the internal shape changes or the
 * value is not a sane non-negative number, so callers fall back to inflating
 * (JSZip's own streaming `data_length === uncompressedSize` check remains the
 * backstop in that case).
 */
function declaredUncompressedSize(entry: JSZip.JSZipObject): number | undefined {
  const data = (entry as unknown as { _data?: { uncompressedSize?: unknown } })._data;
  const size = data?.uncompressedSize;
  return typeof size === 'number' && Number.isFinite(size) && size >= 0 ? size : undefined;
}

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
  sourceLabel: string,
  limits?: DecompressionLimits
): Promise<AppContents> {
  const maxEntryBytes = limits?.maxEntryBytes ?? MAX_ENTRY_UNCOMPRESSED_BYTES;
  const maxTotalBytes = limits?.maxTotalBytes ?? MAX_TOTAL_UNCOMPRESSED_BYTES;
  const maxEntryCount = limits?.maxEntryCount ?? MAX_BUNDLED_ENTRY_COUNT;
  const zip = await openNavxZip(bytes, sourceLabel, 'readApp');
  const { appId, version, name, appPublisher } = await readManifest(zip, sourceLabel, 'readApp');

  const symbolEntry = zip.file('SymbolReference.json');
  if (!symbolEntry) {
    throw new Error(
      `readApp: SymbolReference.json not found inside .app package (source=${sourceLabel})`
    );
  }
  // Bound decompression before inflating anything (see cap constants above).
  // `totalBytes` accumulates the declared uncompressed size across the
  // SymbolReference.json plus every bundled source so a "many medium entries"
  // bomb is caught even when no single entry trips the per-entry cap.
  const symbolSize = declaredUncompressedSize(symbolEntry);
  if (symbolSize !== undefined && symbolSize > maxEntryBytes) {
    throw new Error(
      `readApp: SymbolReference.json declares ${symbolSize} uncompressed bytes, ` +
      `exceeding the ${maxEntryBytes}-byte per-entry cap; refusing to ` +
      `decompress (possible zip bomb) (source=${sourceLabel})`
    );
  }
  let totalBytes = symbolSize ?? 0;
  const symbolReferenceJson = await symbolEntry.async('string');

  const bundledAlSources: { path: string; text: string }[] = [];
  let entryCount = 0;
  for (const [path, entry] of Object.entries(zip.files)) {
    if (entry.dir) {
      continue;
    }
    if (!isBundledAlSource(path)) {
      continue;
    }
    entryCount++;
    if (entryCount > maxEntryCount) {
      throw new Error(
        `readApp: bundled source entry count exceeds the ${maxEntryCount}-entry ` +
        `cap; refusing to decompress (possible zip bomb) (source=${sourceLabel})`
      );
    }
    const entrySize = declaredUncompressedSize(entry);
    if (entrySize !== undefined) {
      if (entrySize > maxEntryBytes) {
        throw new Error(
          `readApp: bundled source ${path} declares ${entrySize} uncompressed bytes, ` +
          `exceeding the ${maxEntryBytes}-byte per-entry cap; refusing to ` +
          `decompress (possible zip bomb) (source=${sourceLabel})`
        );
      }
      totalBytes += entrySize;
      if (totalBytes > maxTotalBytes) {
        throw new Error(
          `readApp: cumulative uncompressed size exceeds the ${maxTotalBytes}-byte ` +
          `cap (reached ${totalBytes} bytes at ${path}); refusing to decompress ` +
          `(possible zip bomb) (source=${sourceLabel})`
        );
      }
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

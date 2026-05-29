import * as assert from 'assert';
import * as vscode from 'vscode';
import JSZip from 'jszip';
import { parseAppBytes, readApp } from '../../symbols/appReader';

const SAMPLE_MANIFEST = `<?xml version="1.0" encoding="utf-8"?>
<Package>
  <App Id="437dbf0e-84ff-417a-965d-ed2bb9650972" Name="Base Application" Publisher="Microsoft" Version="24.0.0.0" />
</Package>`;

const SAMPLE_SYMBOL_REFERENCE = JSON.stringify({ AppId: 'x', Codeunits: [] });

async function buildAppBytes(opts: {
  withManifest?: boolean;
  withSymbolReference?: boolean;
  symbolReferenceText?: string;
  bundledFiles?: Record<string, string>;
  manifestXml?: string;
  prefixMagic?: ReadonlyArray<number>;
  prefixSize?: number;
  /** Use DEFLATE so a highly-compressible multi-MB string yields a tiny `.app`
   *  whose central directory still *declares* the full uncompressed size. */
  compress?: boolean;
} = {}): Promise<Uint8Array> {
  const zip = new JSZip();
  if (opts.withManifest !== false) {
    zip.file('NavxManifest.xml', opts.manifestXml ?? SAMPLE_MANIFEST);
  }
  if (opts.withSymbolReference !== false) {
    zip.file('SymbolReference.json', opts.symbolReferenceText ?? SAMPLE_SYMBOL_REFERENCE);
  }
  for (const [path, content] of Object.entries(opts.bundledFiles ?? {})) {
    zip.file(path, content);
  }
  const zipBytes: Uint8Array = await zip.generateAsync(
    opts.compress
      ? { type: 'uint8array', compression: 'DEFLATE' }
      : { type: 'uint8array' }
  );

  const headerSize = opts.prefixSize ?? 40;
  const out = new Uint8Array(headerSize + zipBytes.length);
  const magic = opts.prefixMagic ?? [0x4E, 0x41, 0x56, 0x58]; // "NAVX"
  for (let i = 0; i < magic.length && i < headerSize; i++) {
    out[i] = magic[i];
  }
  out.set(zipBytes, headerSize);
  return out;
}

suite('symbols/appReader: parseAppBytes happy path', () => {
  test('extracts appId, version, and SymbolReference.json from a minimal package', async () => {
    const bytes = await buildAppBytes();
    const contents = await parseAppBytes(bytes, 'memory://test.app');
    assert.strictEqual(contents.appId, '437dbf0e-84ff-417a-965d-ed2bb9650972');
    assert.strictEqual(contents.version, '24.0.0.0');
    assert.ok(contents.symbolReferenceJson.includes('"AppId":"x"'));
    assert.deepStrictEqual(contents.bundledAlSources, []);
  });

  test('extracts Name and Publisher attributes when present', async () => {
    const bytes = await buildAppBytes();
    const contents = await parseAppBytes(bytes, 'memory://test.app');
    assert.strictEqual(contents.name, 'Base Application');
    assert.strictEqual(contents.appPublisher, 'Microsoft');
  });

  test('Name and Publisher are undefined when the manifest omits them (no throw on the happy path)', async () => {
    const minimalManifest = `<?xml version="1.0" encoding="utf-8"?>
<Package>
  <App Id="11111111-2222-3333-4444-555555555555" Version="1.0.0.0" />
</Package>`;
    const bytes = await buildAppBytes({ manifestXml: minimalManifest });
    const contents = await parseAppBytes(bytes, 'memory://no-meta.app');
    assert.strictEqual(contents.appId, '11111111-2222-3333-4444-555555555555');
    assert.strictEqual(contents.version, '1.0.0.0');
    assert.strictEqual(contents.name, undefined);
    assert.strictEqual(contents.appPublisher, undefined);
  });

  test('returns bundled AL sources from src/**/*.al', async () => {
    const bytes = await buildAppBytes({
      bundledFiles: {
        'src/Sales.Codeunit.al': 'codeunit 50100 "Sales" { }',
        'src/Customer.Page.al': 'page 50200 "Cust" { }'
      }
    });
    const { bundledAlSources } = await parseAppBytes(bytes, 'memory://test.app');
    assert.strictEqual(bundledAlSources.length, 2);
    const codeunitFile = bundledAlSources.find(s => s.path === 'src/Sales.Codeunit.al');
    assert.ok(codeunitFile);
    assert.strictEqual(codeunitFile!.text, 'codeunit 50100 "Sales" { }');
  });

  test('ignores files outside src/', async () => {
    const bytes = await buildAppBytes({
      bundledFiles: {
        'src/InScope.al': 'in',
        'Translations/Base.xlf': 'out',
        'permissionsets/foo.al': 'also-out'
      }
    });
    const { bundledAlSources } = await parseAppBytes(bytes, 'memory://test.app');
    assert.strictEqual(bundledAlSources.length, 1);
    assert.strictEqual(bundledAlSources[0].path, 'src/InScope.al');
  });

  test('ignores non-.al files inside src/', async () => {
    const bytes = await buildAppBytes({
      bundledFiles: {
        'src/keep.al': 'in',
        'src/skip.md': 'out',
        'src/skip.xml': 'out'
      }
    });
    const { bundledAlSources } = await parseAppBytes(bytes, 'memory://test.app');
    assert.strictEqual(bundledAlSources.length, 1);
    assert.strictEqual(bundledAlSources[0].path, 'src/keep.al');
  });
});

suite('symbols/appReader: parseAppBytes error paths', () => {
  test('throws when input is shorter than the NAVX header', async () => {
    await assert.rejects(
      parseAppBytes(new Uint8Array(10), 'memory://tiny.app'),
      /file too small to be a \.app package/
    );
  });

  test('throws when the magic bytes are not NAVX', async () => {
    const bytes = await buildAppBytes({ prefixMagic: [0xDE, 0xAD, 0xBE, 0xEF] });
    await assert.rejects(
      parseAppBytes(bytes, 'memory://wrong.app'),
      /not a NAVX-formatted .app package/
    );
  });

  test('throws when NavxManifest.xml is missing', async () => {
    const bytes = await buildAppBytes({ withManifest: false });
    await assert.rejects(
      parseAppBytes(bytes, 'memory://no-manifest.app'),
      /NavxManifest\.xml not found/
    );
  });

  test('throws when SymbolReference.json is missing', async () => {
    const bytes = await buildAppBytes({ withSymbolReference: false });
    await assert.rejects(
      parseAppBytes(bytes, 'memory://no-symbols.app'),
      /SymbolReference\.json not found/
    );
  });

  test('throws when <App> element missing Id attribute', async () => {
    const xml = '<?xml version="1.0"?><Package><App Version="1.0" /></Package>';
    const bytes = await buildAppBytes({ manifestXml: xml });
    await assert.rejects(
      parseAppBytes(bytes, 'memory://bad-manifest.app'),
      /missing Id or Version attribute/
    );
  });
});

suite('symbols/appReader: decompression caps (zip-bomb defense)', () => {
  // Mirrors the (non-exported) caps in appReader.ts. Kept in sync by intent:
  // the tests below craft entries that clear these exact thresholds.
  const MAX_ENTRY_UNCOMPRESSED_BYTES = 256 * 1024 * 1024;
  const MAX_TOTAL_UNCOMPRESSED_BYTES = 512 * 1024 * 1024;
  const MAX_BUNDLED_ENTRY_COUNT = 50_000;

  test('rejects a SymbolReference.json that declares more than the per-entry cap', async function () {
    // ~256 MB of a single repeated char compresses to a few hundred KB, so the
    // crafted `.app` stays tiny on disk while its central directory declares the
    // full uncompressed size. The guard fires BEFORE `.async`, so the payload is
    // never inflated — only the declared size matters.
    this.timeout(30000);
    const big = 'A'.repeat(MAX_ENTRY_UNCOMPRESSED_BYTES + 1);
    const bytes = await buildAppBytes({ symbolReferenceText: big, compress: true });
    await assert.rejects(
      parseAppBytes(bytes, 'memory://bomb-symbol.app'),
      /possible zip bomb/
    );
    await assert.rejects(
      parseAppBytes(bytes, 'memory://bomb-symbol.app'),
      /SymbolReference\.json declares .* per-entry cap/
    );
  });

  test('rejects when bundled sources exceed the cumulative cap', async function () {
    // Each bundled entry declares 200 MB (< the 256 MB per-entry cap), but three
    // of them sum to 600 MB (> the 512 MB cumulative cap). A single shared source
    // string keeps the test to one large allocation.
    this.timeout(30000);
    const perEntry = 200 * 1024 * 1024;
    assert.ok(perEntry < MAX_ENTRY_UNCOMPRESSED_BYTES, 'per-entry must stay under the per-entry cap');
    assert.ok(perEntry * 3 > MAX_TOTAL_UNCOMPRESSED_BYTES, 'three entries must exceed the cumulative cap');
    const big = 'B'.repeat(perEntry);
    const bytes = await buildAppBytes({
      bundledFiles: { 'src/a.al': big, 'src/b.al': big, 'src/c.al': big },
      compress: true
    });
    await assert.rejects(
      parseAppBytes(bytes, 'memory://bomb-cumulative.app'),
      /cumulative uncompressed size exceeds/
    );
    await assert.rejects(
      parseAppBytes(bytes, 'memory://bomb-cumulative.app'),
      /possible zip bomb/
    );
  });

  test('rejects when the bundled entry count exceeds the cap', async function () {
    // The count check fires before any inflation, so many tiny entries are cheap.
    this.timeout(30000);
    const bundledFiles: Record<string, string> = {};
    for (let i = 0; i <= MAX_BUNDLED_ENTRY_COUNT; i++) {
      bundledFiles[`src/f${i}.al`] = 'x';
    }
    const bytes = await buildAppBytes({ bundledFiles });
    await assert.rejects(
      parseAppBytes(bytes, 'memory://bomb-count.app'),
      /bundled source entry count exceeds/
    );
    await assert.rejects(
      parseAppBytes(bytes, 'memory://bomb-count.app'),
      /possible zip bomb/
    );
  });

  test('accepts a normal package unchanged (caps do not reject legitimate apps)', async () => {
    const bytes = await buildAppBytes({
      bundledFiles: {
        'src/Sales.Codeunit.al': 'codeunit 50100 "Sales" { }',
        'src/Customer.Page.al': 'page 50200 "Cust" { }'
      }
    });
    const contents = await parseAppBytes(bytes, 'memory://normal.app');
    assert.strictEqual(contents.appId, '437dbf0e-84ff-417a-965d-ed2bb9650972');
    assert.strictEqual(contents.bundledAlSources.length, 2);
  });
});

suite('symbols/appReader: readApp .NEA detection', () => {
  test('rejects a .NEA URI before reading any bytes', async () => {
    const uri = vscode.Uri.parse('file:///fake/path/Some.NEA');
    await assert.rejects(
      readApp(uri),
      /\.NEA runtime packages are encrypted and unsupported/
    );
  });

  test('rejects a .nea (lowercase) URI', async () => {
    const uri = vscode.Uri.parse('file:///fake/path/some.nea');
    await assert.rejects(
      readApp(uri),
      /\.NEA runtime packages are encrypted and unsupported/
    );
  });
});

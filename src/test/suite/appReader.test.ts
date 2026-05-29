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
  // The production caps (256 MB / 512 MB / 50,000) are large by design, so these
  // tests inject small `limits` into `parseAppBytes` to exercise the cap LOGIC
  // with tiny inputs rather than materializing huge zips — building 50k entries
  // or hundreds of MB ran ~25-30s and flaked against the mocha timeout on the
  // Windows CI runner (issue #139). The guards read each entry's DECLARED
  // uncompressed size and fire before `.async`, so nothing is ever inflated.
  // The production defaults are exercised by the "accepts a normal package" test.

  test('rejects a SymbolReference.json that declares more than the per-entry cap', async () => {
    // 65-byte symbol vs an injected 64-byte per-entry cap.
    const bytes = await buildAppBytes({ symbolReferenceText: 'A'.repeat(65) });
    await assert.rejects(
      parseAppBytes(bytes, 'memory://bomb-symbol.app', { maxEntryBytes: 64 }),
      /possible zip bomb/
    );
    await assert.rejects(
      parseAppBytes(bytes, 'memory://bomb-symbol.app', { maxEntryBytes: 64 }),
      /SymbolReference\.json declares .* per-entry cap/
    );
  });

  test('rejects when bundled sources exceed the cumulative cap', async () => {
    // Each entry stays under the (high) per-entry cap, but the 40-byte symbol
    // plus the first 80-byte bundled entry sum past the injected 100-byte
    // cumulative cap.
    const bytes = await buildAppBytes({
      symbolReferenceText: 'S'.repeat(40),
      bundledFiles: { 'src/a.al': 'A'.repeat(80), 'src/b.al': 'B'.repeat(80) }
    });
    const limits = { maxEntryBytes: 1000, maxTotalBytes: 100 };
    await assert.rejects(
      parseAppBytes(bytes, 'memory://bomb-cumulative.app', limits),
      /cumulative uncompressed size exceeds/
    );
    await assert.rejects(
      parseAppBytes(bytes, 'memory://bomb-cumulative.app', limits),
      /possible zip bomb/
    );
  });

  test('rejects when the bundled entry count exceeds the cap', async () => {
    // 4 tiny entries vs an injected count cap of 3; the count check fires before
    // any inflation, so this is instant.
    const bundledFiles: Record<string, string> = {};
    for (let i = 0; i <= 3; i++) {
      bundledFiles[`src/f${i}.al`] = 'x';
    }
    const bytes = await buildAppBytes({ bundledFiles });
    await assert.rejects(
      parseAppBytes(bytes, 'memory://bomb-count.app', { maxEntryCount: 3 }),
      /bundled source entry count exceeds/
    );
    await assert.rejects(
      parseAppBytes(bytes, 'memory://bomb-count.app', { maxEntryCount: 3 }),
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

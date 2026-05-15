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
  bundledFiles?: Record<string, string>;
  manifestXml?: string;
  prefixMagic?: ReadonlyArray<number>;
  prefixSize?: number;
} = {}): Promise<Uint8Array> {
  const zip = new JSZip();
  if (opts.withManifest !== false) {
    zip.file('NavxManifest.xml', opts.manifestXml ?? SAMPLE_MANIFEST);
  }
  if (opts.withSymbolReference !== false) {
    zip.file('SymbolReference.json', SAMPLE_SYMBOL_REFERENCE);
  }
  for (const [path, content] of Object.entries(opts.bundledFiles ?? {})) {
    zip.file(path, content);
  }
  const zipBytes: Uint8Array = await zip.generateAsync({ type: 'uint8array' });

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

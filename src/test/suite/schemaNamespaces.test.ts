import * as assert from 'assert';
import { parseNamespacesSymbols } from '../../symbols/schemaNamespaces';
import { parseSymbolReference } from '../../symbols/detect';

const APP_ID = '437dbf0e-84ff-417a-965d-ed2bb9650972';

function codeunit(id: number, name: string, eventName: string, attrName = 'IntegrationEvent'): object {
  return {
    Id: id,
    Name: name,
    Methods: [{ Name: eventName, Attributes: [{ Name: attrName, Arguments: [] }] }]
  };
}

suite('symbols/schemaNamespaces: happy path', () => {
  test('extracts events from a single top-level namespace', () => {
    const json = {
      AppId: APP_ID,
      Namespaces: [
        {
          Name: 'Microsoft.Foundation',
          Codeunits: [codeunit(50100, 'Cu', 'OnEvent')]
        }
      ]
    };
    const publishers = parseNamespacesSymbols(json, APP_ID);
    assert.strictEqual(publishers.length, 1);
    assert.strictEqual(publishers[0].eventName, 'OnEvent');
    assert.strictEqual(publishers[0].owner.name, 'Cu');
  });

  test('extracts events from nested namespaces (3 levels deep)', () => {
    const json = {
      Namespaces: [
        {
          Name: 'L1',
          Codeunits: [codeunit(1, 'L1Cu', 'OnL1')],
          Namespaces: [
            {
              Name: 'L1.L2',
              Codeunits: [codeunit(2, 'L2Cu', 'OnL2')],
              Namespaces: [
                {
                  Name: 'L1.L2.L3',
                  Codeunits: [codeunit(3, 'L3Cu', 'OnL3')]
                }
              ]
            }
          ]
        }
      ]
    };
    const publishers = parseNamespacesSymbols(json, APP_ID);
    assert.strictEqual(publishers.length, 3);
    const names = publishers.map((p) => p.eventName).sort();
    assert.deepStrictEqual(names, ['OnL1', 'OnL2', 'OnL3']);
  });

  test('extracts events from root-level arrays AND nested namespaces in the same package', () => {
    const json = {
      Codeunits: [codeunit(10, 'RootCu', 'OnRoot')],
      Namespaces: [
        {
          Name: 'Foo',
          Codeunits: [codeunit(20, 'NsCu', 'OnNamespaced')]
        }
      ]
    };
    const publishers = parseNamespacesSymbols(json, APP_ID);
    assert.strictEqual(publishers.length, 2);
    const byEvent = new Map(publishers.map((p) => [p.eventName, p.owner.name]));
    assert.strictEqual(byEvent.get('OnRoot'), 'RootCu');
    assert.strictEqual(byEvent.get('OnNamespaced'), 'NsCu');
  });

  test('mixed object kinds inside a single namespace', () => {
    const json = {
      Namespaces: [
        {
          Name: 'Mixed',
          Codeunits: [codeunit(1, 'CuOne', 'OnCu')],
          Tables: [
            { Id: 2, Name: 'TableOne', Methods: [{ Name: 'OnTable', Attributes: [{ Name: 'IntegrationEvent' }] }] }
          ],
          Pages: [
            { Id: 3, Name: 'PageOne', Methods: [{ Name: 'OnPage', Attributes: [{ Name: 'BusinessEvent' }] }] }
          ]
        }
      ]
    };
    const publishers = parseNamespacesSymbols(json, APP_ID);
    assert.strictEqual(publishers.length, 3);
    const kinds = new Map(publishers.map((p) => [p.owner.kind, p.eventName]));
    assert.strictEqual(kinds.get('codeunit'), 'OnCu');
    assert.strictEqual(kinds.get('table'), 'OnTable');
    assert.strictEqual(kinds.get('page'), 'OnPage');
  });

  test('extracts TableExtension / PageExtension events through the nested walk', () => {
    // Regression for issue #123: the nested `Namespaces[]` walk reuses the
    // same `CONTAINER_KINDS` enumeration as the flat parser
    // (`walkNamespaceTree` -> `extractPublishersFromContainer`), so adding the
    // two extension keys must surface their publishers under the BC 24+ schema
    // too. In a real BC 28 Base Application these objects sit deep inside
    // `Namespaces[]`, which is exactly the surface this test guards.
    const json = {
      Namespaces: [
        {
          Name: 'Extensions',
          TableExtensions: [
            {
              Id: 50700,
              Name: 'TblExt',
              Methods: [{ Name: 'OnTableExt', Attributes: [{ Name: 'IntegrationEvent' }] }]
            }
          ],
          PageExtensions: [
            {
              Id: 50800,
              Name: 'PgExt',
              Methods: [{ Name: 'OnPageExt', Attributes: [{ Name: 'BusinessEvent' }] }]
            }
          ]
        }
      ]
    };
    const publishers = parseNamespacesSymbols(json, APP_ID);
    assert.strictEqual(publishers.length, 2);
    const kinds = new Map(publishers.map((p) => [p.owner.kind, p.eventName]));
    assert.strictEqual(kinds.get('tableextension'), 'OnTableExt');
    assert.strictEqual(kinds.get('pageextension'), 'OnPageExt');
  });
});

suite('symbols/schemaNamespaces: filtering and edge cases', () => {
  test('empty Namespaces[] array produces no publishers', () => {
    const json = { Namespaces: [] };
    assert.deepStrictEqual(parseNamespacesSymbols(json, APP_ID), []);
  });

  test('missing Namespaces[] key still walks root arrays', () => {
    const json = { Codeunits: [codeunit(1, 'RootOnly', 'OnRoot')] };
    const publishers = parseNamespacesSymbols(json, APP_ID);
    assert.strictEqual(publishers.length, 1);
    assert.strictEqual(publishers[0].eventName, 'OnRoot');
  });

  test('namespace without object arrays is skipped silently', () => {
    const json = {
      Namespaces: [
        { Name: 'EmptyNs' },
        { Name: 'HasOne', Codeunits: [codeunit(1, 'X', 'OnX')] }
      ]
    };
    const publishers = parseNamespacesSymbols(json, APP_ID);
    assert.strictEqual(publishers.length, 1);
    assert.strictEqual(publishers[0].eventName, 'OnX');
  });
});

suite('symbols/schemaNamespaces: input forms', () => {
  test('accepts a JSON string', () => {
    const jsonString = JSON.stringify({
      Namespaces: [{ Name: 'Foo', Codeunits: [codeunit(1, 'Cu', 'OnFromString')] }]
    });
    const publishers = parseNamespacesSymbols(jsonString, APP_ID);
    assert.strictEqual(publishers.length, 1);
    assert.strictEqual(publishers[0].eventName, 'OnFromString');
  });

  test('strips a leading UTF-8 BOM before parsing a string', () => {
    const jsonString =
      '﻿' +
      JSON.stringify({
        Namespaces: [{ Name: 'Foo', Codeunits: [codeunit(1, 'Cu', 'OnAfterBom')] }]
      });
    const publishers = parseNamespacesSymbols(jsonString, APP_ID);
    assert.strictEqual(publishers.length, 1);
    assert.strictEqual(publishers[0].eventName, 'OnAfterBom');
  });

  test('rejects null', () => {
    assert.throws(() => parseNamespacesSymbols(null, APP_ID), /input is null/);
  });

  test('rejects a malformed JSON string', () => {
    assert.throws(() => parseNamespacesSymbols('{ not json', APP_ID), /not valid JSON/);
  });
});

suite('symbols/detect: dispatch', () => {
  test('routes BC24+ schema (with Namespaces) to the nested parser', () => {
    const json = {
      AppId: APP_ID,
      Namespaces: [{ Name: 'Foo', Codeunits: [codeunit(1, 'Cu', 'OnNested')] }]
    };
    const publishers = parseSymbolReference(json, APP_ID);
    assert.strictEqual(publishers.length, 1);
    assert.strictEqual(publishers[0].eventName, 'OnNested');
  });

  test('routes legacy flat schema (no Namespaces) to the flat parser', () => {
    const json = {
      AppId: APP_ID,
      Codeunits: [codeunit(1, 'Cu', 'OnFlat')]
    };
    const publishers = parseSymbolReference(json, APP_ID);
    assert.strictEqual(publishers.length, 1);
    assert.strictEqual(publishers[0].eventName, 'OnFlat');
  });

  test('accepts a JSON string carrying the nested Namespaces[] schema', () => {
    // Regression: the indexer calls parseSymbolReference with the raw
    // SymbolReference.json string (AppContents.symbolReferenceJson is typed
    // string), not an already-parsed object. The previous dispatcher only
    // recognized the nested schema when typeof json === 'object', so string
    // inputs were silently routed to the flat-only walk — dropping every
    // publisher inside Namespaces[] in BC 24+ packages (which is basically
    // all of BaseApp).
    const jsonString = JSON.stringify({
      AppId: APP_ID,
      Namespaces: [{ Name: 'Foo', Codeunits: [codeunit(1, 'Cu', 'OnFromString')] }]
    });
    const publishers = parseSymbolReference(jsonString, APP_ID);
    assert.strictEqual(publishers.length, 1);
    assert.strictEqual(publishers[0].eventName, 'OnFromString');
  });

  test('hybrid schemas (top-level Codeunits[] AND Namespaces[]) return publishers from both surfaces', () => {
    // Regression: BC 26+ Microsoft BaseApp ships both a small set of
    // un-namespaced top-level objects AND a large nested Namespaces[] tree.
    // The dispatcher must not treat the schemas as mutually exclusive; the
    // unified walk extracts from both.
    const json = {
      AppId: APP_ID,
      Codeunits: [codeunit(1, 'LegacyCu', 'OnLegacy')],
      Namespaces: [
        { Name: 'Sales.Posting', Codeunits: [codeunit(80, 'Sales-Post', 'OnAfterPostSalesDoc')] }
      ]
    };
    const publishers = parseSymbolReference(json, APP_ID);
    const names = publishers.map((p) => `${p.owner.name}.${p.eventName}`).sort();
    assert.deepStrictEqual(names, [
      'LegacyCu.OnLegacy',
      'Sales-Post.OnAfterPostSalesDoc'
    ]);
  });
});

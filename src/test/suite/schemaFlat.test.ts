import * as assert from 'assert';
import { extractPublishersFromContainer, parseFlatSymbols } from '../../symbols/schemaFlat';

const APP_ID = '437dbf0e-84ff-417a-965d-ed2bb9650972';

function withMethods(name: string, kind: 'IntegrationEvent' | 'BusinessEvent' | 'Other'): object {
  return {
    Id: 50100,
    Name: 'My Codeunit',
    Methods: [
      {
        Id: 1,
        Name: name,
        Attributes: [{ Name: kind, Arguments: [] }]
      }
    ]
  };
}

suite('symbols/schemaFlat: happy path', () => {
  test('extracts a single IntegrationEvent from a codeunit', () => {
    const json = {
      AppId: APP_ID,
      Codeunits: [withMethods('OnAfterFoo', 'IntegrationEvent')]
    };
    const publishers = parseFlatSymbols(json, APP_ID);
    assert.strictEqual(publishers.length, 1);
    assert.strictEqual(publishers[0].eventName, 'OnAfterFoo');
    assert.strictEqual(publishers[0].kind, 'integration');
    assert.strictEqual(publishers[0].owner.kind, 'codeunit');
    assert.strictEqual(publishers[0].owner.id, 50100);
    assert.strictEqual(publishers[0].owner.name, 'My Codeunit');
    assert.strictEqual(publishers[0].owner.appId, APP_ID);
    assert.strictEqual(publishers[0].location, undefined);
  });

  test('extracts a single BusinessEvent from a codeunit', () => {
    const json = {
      Codeunits: [withMethods('OnSomethingBusinessy', 'BusinessEvent')]
    };
    const publishers = parseFlatSymbols(json, APP_ID);
    assert.strictEqual(publishers.length, 1);
    assert.strictEqual(publishers[0].kind, 'business');
  });

  test('extracts multiple events from a single object', () => {
    const json = {
      Codeunits: [
        {
          Id: 50100,
          Name: 'Multi',
          Methods: [
            { Id: 1, Name: 'OnFirst', Attributes: [{ Name: 'IntegrationEvent' }] },
            { Id: 2, Name: 'OnSecond', Attributes: [{ Name: 'BusinessEvent' }] },
            { Id: 3, Name: 'OnThird', Attributes: [{ Name: 'IntegrationEvent' }] }
          ]
        }
      ]
    };
    const publishers = parseFlatSymbols(json, APP_ID);
    assert.strictEqual(publishers.length, 3);
    assert.deepStrictEqual(
      publishers.map((p) => p.eventName).sort(),
      ['OnFirst', 'OnSecond', 'OnThird']
    );
    const integrationCount = publishers.filter((p) => p.kind === 'integration').length;
    const businessCount = publishers.filter((p) => p.kind === 'business').length;
    assert.strictEqual(integrationCount, 2);
    assert.strictEqual(businessCount, 1);
  });

  test('extracts events from Tables, Pages, Reports, Queries, XmlPorts, and Interfaces', () => {
    const json = {
      Codeunits: [],
      Tables: [
        { Id: 50200, Name: 'My Table', Methods: [{ Name: 'OnTable', Attributes: [{ Name: 'IntegrationEvent' }] }] }
      ],
      Pages: [
        { Id: 50300, Name: 'My Page', Methods: [{ Name: 'OnPage', Attributes: [{ Name: 'IntegrationEvent' }] }] }
      ],
      Reports: [
        { Id: 50400, Name: 'My Report', Methods: [{ Name: 'OnReport', Attributes: [{ Name: 'IntegrationEvent' }] }] }
      ],
      Queries: [
        { Id: 50500, Name: 'My Query', Methods: [{ Name: 'OnQuery', Attributes: [{ Name: 'IntegrationEvent' }] }] }
      ],
      XmlPorts: [
        { Id: 50600, Name: 'My XmlPort', Methods: [{ Name: 'OnXml', Attributes: [{ Name: 'IntegrationEvent' }] }] }
      ],
      Interfaces: [
        { Name: 'IMine', Methods: [{ Name: 'OnIface', Attributes: [{ Name: 'IntegrationEvent' }] }] }
      ]
    };
    const publishers = parseFlatSymbols(json, APP_ID);
    const byKind = new Map(publishers.map((p) => [p.owner.kind, p.eventName]));
    assert.strictEqual(byKind.get('table'), 'OnTable');
    assert.strictEqual(byKind.get('page'), 'OnPage');
    assert.strictEqual(byKind.get('report'), 'OnReport');
    assert.strictEqual(byKind.get('query'), 'OnQuery');
    assert.strictEqual(byKind.get('xmlport'), 'OnXml');
    assert.strictEqual(byKind.get('interface'), 'OnIface');
  });

  test('extracts events from TableExtensions and PageExtensions', () => {
    // Regression for issue #123: BC `tableextension`/`pageextension` objects
    // can legally declare `[IntegrationEvent]`/`[BusinessEvent]` procedures,
    // and those ARE preserved in `SymbolReference.json` under the
    // `TableExtensions[]` / `PageExtensions[]` array keys (confirmed against a
    // real BC 28 Base Application package: 109 such publishers). They were
    // previously dropped because `CONTAINER_KINDS` omitted both keys.
    const json = {
      TableExtensions: [
        {
          Id: 50700,
          Name: 'My Table Ext',
          Methods: [{ Name: 'OnTableExt', Attributes: [{ Name: 'IntegrationEvent' }] }]
        }
      ],
      PageExtensions: [
        {
          Id: 50800,
          Name: 'My Page Ext',
          Methods: [{ Name: 'OnPageExt', Attributes: [{ Name: 'BusinessEvent' }] }]
        }
      ]
    };
    const publishers = parseFlatSymbols(json, APP_ID);
    assert.strictEqual(publishers.length, 2);
    const byKind = new Map(publishers.map((p) => [p.owner.kind, p.eventName]));
    assert.strictEqual(byKind.get('tableextension'), 'OnTableExt');
    assert.strictEqual(byKind.get('pageextension'), 'OnPageExt');
  });

  test('extracts events from ReportExtensions', () => {
    // Regression for issue #157: BC `reportextension` objects can declare
    // `[IntegrationEvent]`/`[BusinessEvent]` procedures, preserved in
    // `SymbolReference.json` under the `ReportExtensions[]` key (parallel to
    // the `TableExtensions`/`PageExtensions` keys added in #123). Previously
    // dropped because `CONTAINER_KINDS` omitted the key — even though the AL
    // source parser already treats `reportextension` as event-hosting.
    const json = {
      ReportExtensions: [
        {
          Id: 50900,
          Name: 'My Report Ext',
          Methods: [{ Name: 'OnReportExt', Attributes: [{ Name: 'IntegrationEvent' }] }]
        }
      ]
    };
    const publishers = parseFlatSymbols(json, APP_ID);
    assert.strictEqual(publishers.length, 1);
    assert.strictEqual(publishers[0].owner.kind, 'reportextension');
    assert.strictEqual(publishers[0].eventName, 'OnReportExt');
  });
});

suite('symbols/schemaFlat: filtering', () => {
  test('methods with no Attributes are ignored', () => {
    const json = {
      Codeunits: [
        {
          Id: 50100,
          Name: 'Mixed',
          Methods: [
            { Name: 'RegularMethod' },
            { Name: 'OnAfterFoo', Attributes: [{ Name: 'IntegrationEvent' }] }
          ]
        }
      ]
    };
    const publishers = parseFlatSymbols(json, APP_ID);
    assert.strictEqual(publishers.length, 1);
    assert.strictEqual(publishers[0].eventName, 'OnAfterFoo');
  });

  test('methods with only non-event attributes are ignored', () => {
    const json = {
      Codeunits: [
        {
          Id: 50100,
          Name: 'WithScope',
          Methods: [
            { Name: 'AnObsoleteOne', Attributes: [{ Name: 'Obsolete', Arguments: [] }] },
            { Name: 'AScoped', Attributes: [{ Name: 'Scope', Arguments: [{ Value: 'OnPrem' }] }] },
            { Name: 'OnRealEvent', Attributes: [{ Name: 'IntegrationEvent' }] }
          ]
        }
      ]
    };
    const publishers = parseFlatSymbols(json, APP_ID);
    assert.strictEqual(publishers.length, 1);
    assert.strictEqual(publishers[0].eventName, 'OnRealEvent');
  });

  test('attribute Name matching is case-insensitive', () => {
    const json = {
      Codeunits: [
        {
          Id: 50100,
          Name: 'CaseTest',
          Methods: [
            { Name: 'OnLower', Attributes: [{ Name: 'integrationevent' }] },
            { Name: 'OnUpper', Attributes: [{ Name: 'INTEGRATIONEVENT' }] }
          ]
        }
      ]
    };
    const publishers = parseFlatSymbols(json, APP_ID);
    assert.strictEqual(publishers.length, 2);
    assert.ok(publishers.every((p) => p.kind === 'integration'));
  });

  test('empty top-level arrays produce no publishers', () => {
    const json = { Codeunits: [], Tables: [], Pages: [] };
    assert.deepStrictEqual(parseFlatSymbols(json, APP_ID), []);
  });

  test('missing top-level keys are tolerated', () => {
    const json = { AppId: APP_ID };
    assert.deepStrictEqual(parseFlatSymbols(json, APP_ID), []);
  });

  test('objects missing Methods array are skipped, not an error', () => {
    const json = {
      Codeunits: [
        { Id: 1, Name: 'NoMethods' },
        { Id: 2, Name: 'HasMethods', Methods: [{ Name: 'OnX', Attributes: [{ Name: 'IntegrationEvent' }] }] }
      ]
    };
    const publishers = parseFlatSymbols(json, APP_ID);
    assert.strictEqual(publishers.length, 1);
    assert.strictEqual(publishers[0].owner.name, 'HasMethods');
  });
});

suite('symbols/schemaFlat: input forms', () => {
  test('accepts a JSON string', () => {
    const jsonString = JSON.stringify({
      Codeunits: [withMethods('OnFromString', 'IntegrationEvent')]
    });
    const publishers = parseFlatSymbols(jsonString, APP_ID);
    assert.strictEqual(publishers.length, 1);
    assert.strictEqual(publishers[0].eventName, 'OnFromString');
  });

  test('strips a leading UTF-8 BOM before parsing a string', () => {
    const jsonString =
      '﻿' +
      JSON.stringify({
        Codeunits: [withMethods('OnAfterBom', 'IntegrationEvent')]
      });
    const publishers = parseFlatSymbols(jsonString, APP_ID);
    assert.strictEqual(publishers.length, 1);
    assert.strictEqual(publishers[0].eventName, 'OnAfterBom');
  });

  test('rejects null', () => {
    assert.throws(() => parseFlatSymbols(null, APP_ID), /input is null/);
  });

  test('rejects a number', () => {
    assert.throws(() => parseFlatSymbols(42, APP_ID), /input is a number/);
  });

  test('rejects a malformed JSON string', () => {
    assert.throws(() => parseFlatSymbols('{ not json', APP_ID), /not valid JSON/);
  });
});

suite('symbols/schemaFlat: extractPublishersFromContainer', () => {
  test('is exported and accepts an already-parsed object directly', () => {
    const container = { Codeunits: [withMethods('OnFromHelper', 'IntegrationEvent')] };
    const publishers = extractPublishersFromContainer(container, APP_ID);
    assert.strictEqual(publishers.length, 1);
    assert.strictEqual(publishers[0].eventName, 'OnFromHelper');
  });

  test('returns [] for a non-object container', () => {
    assert.deepStrictEqual(extractPublishersFromContainer(null, APP_ID), []);
    assert.deepStrictEqual(extractPublishersFromContainer(42, APP_ID), []);
    assert.deepStrictEqual(extractPublishersFromContainer('x', APP_ID), []);
  });
});

suite('symbols/schemaFlat: publisher parameters', () => {
  test('extracts Parameters[] with IsVar + Subtype Record', () => {
    const json = {
      Codeunits: [
        {
          Id: 50100,
          Name: 'Sales-Post',
          Methods: [
            {
              Name: 'OnAfterPostSalesOrder',
              Attributes: [{ Name: 'IntegrationEvent' }],
              Parameters: [
                {
                  Name: 'SalesHeader',
                  TypeDefinition: { Name: 'Record', Subtype: { Name: 'Sales Header' } },
                  IsVar: true
                },
                {
                  Name: 'CommitIsSuppressed',
                  TypeDefinition: { Name: 'Boolean' },
                  IsVar: false
                }
              ]
            }
          ]
        }
      ]
    };
    const publishers = parseFlatSymbols(json, APP_ID);
    assert.deepStrictEqual(publishers[0].parameters, [
      { name: 'SalesHeader', typeText: 'Record "Sales Header"', isVar: true },
      { name: 'CommitIsSuppressed', typeText: 'Boolean', isVar: false }
    ]);
  });

  test('Code/Text Length renders as Code[N] / Text[N]', () => {
    const json = {
      Codeunits: [
        {
          Name: 'C',
          Methods: [
            {
              Name: 'OnLookup',
              Attributes: [{ Name: 'IntegrationEvent' }],
              Parameters: [
                { Name: 'No', TypeDefinition: { Name: 'Code', Length: 20 } },
                { Name: 'Description', TypeDefinition: { Name: 'Text', Length: 50 } }
              ]
            }
          ]
        }
      ]
    };
    const publishers = parseFlatSymbols(json, APP_ID);
    assert.deepStrictEqual(publishers[0].parameters, [
      { name: 'No', typeText: 'Code[20]', isVar: false },
      { name: 'Description', typeText: 'Text[50]', isVar: false }
    ]);
  });

  test('Subtype name without spaces is rendered unquoted', () => {
    const json = {
      Codeunits: [
        {
          Name: 'C',
          Methods: [
            {
              Name: 'OnE',
              Attributes: [{ Name: 'IntegrationEvent' }],
              Parameters: [
                { Name: 'Cust', TypeDefinition: { Name: 'Record', Subtype: { Name: 'Customer' } } }
              ]
            }
          ]
        }
      ]
    };
    const publishers = parseFlatSymbols(json, APP_ID);
    assert.deepStrictEqual(publishers[0].parameters, [
      { name: 'Cust', typeText: 'Record Customer', isVar: false }
    ]);
  });

  test('generic types via TypeArguments render as `Base of [Arg, ...]`', () => {
    const json = {
      Codeunits: [
        {
          Name: 'C',
          Methods: [
            {
              Name: 'OnE',
              Attributes: [{ Name: 'IntegrationEvent' }],
              Parameters: [
                {
                  Name: 'Items',
                  TypeDefinition: {
                    Name: 'List',
                    TypeArguments: [{ Name: 'Code', Length: 20 }]
                  }
                }
              ]
            }
          ]
        }
      ]
    };
    const publishers = parseFlatSymbols(json, APP_ID);
    assert.deepStrictEqual(publishers[0].parameters, [
      { name: 'Items', typeText: 'List of [Code[20]]', isVar: false }
    ]);
  });

  test('missing Parameters[] yields parameters: undefined (not []) — distinguishes "no signature info" from "no params"', () => {
    const json = {
      Codeunits: [
        {
          Name: 'C',
          Methods: [
            { Name: 'OnE', Attributes: [{ Name: 'IntegrationEvent' }] }
          ]
        }
      ]
    };
    const publishers = parseFlatSymbols(json, APP_ID);
    assert.strictEqual(publishers[0].parameters, undefined);
  });

  test('empty Parameters[] yields parameters: []', () => {
    const json = {
      Codeunits: [
        {
          Name: 'C',
          Methods: [
            { Name: 'OnE', Attributes: [{ Name: 'IntegrationEvent' }], Parameters: [] }
          ]
        }
      ]
    };
    const publishers = parseFlatSymbols(json, APP_ID);
    assert.deepStrictEqual(publishers[0].parameters, []);
  });

  test('malformed parameter entries are skipped silently', () => {
    const json = {
      Codeunits: [
        {
          Name: 'C',
          Methods: [
            {
              Name: 'OnE',
              Attributes: [{ Name: 'IntegrationEvent' }],
              Parameters: [
                'not an object',
                { Name: 'OK', TypeDefinition: { Name: 'Boolean' } },
                { Name: 'NoType' }, // missing TypeDefinition
                { TypeDefinition: { Name: 'Boolean' } } // missing Name
              ]
            }
          ]
        }
      ]
    };
    const publishers = parseFlatSymbols(json, APP_ID);
    assert.deepStrictEqual(publishers[0].parameters, [
      { name: 'OK', typeText: 'Boolean', isVar: false }
    ]);
  });
});

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

import * as assert from 'assert';
import * as vscode from 'vscode';
import type { ObjectKind, ObjectRef } from '../../al/types';
import { collectTriggerOwners, synthesizeTriggerPublishers } from '../../al/triggers';

const EXPECTED_TABLE_EVENTS: ReadonlyArray<string> = [
  'OnBeforeInsertEvent',
  'OnAfterInsertEvent',
  'OnBeforeModifyEvent',
  'OnAfterModifyEvent',
  'OnBeforeDeleteEvent',
  'OnAfterDeleteEvent',
  'OnBeforeRenameEvent',
  'OnAfterRenameEvent',
  'OnBeforeValidateEvent',
  'OnAfterValidateEvent'
];

const EXPECTED_PAGE_EVENTS: ReadonlyArray<string> = [
  'OnOpenPageEvent',
  'OnClosePageEvent',
  'OnQueryClosePageEvent',
  'OnInsertRecordEvent',
  'OnModifyRecordEvent',
  'OnDeleteRecordEvent',
  'OnNewRecordEvent',
  'OnAfterGetCurrRecordEvent'
];

const EMPTY_KINDS: ReadonlyArray<ObjectKind> = [
  'codeunit',
  'tableextension',
  'pageextension',
  'report',
  'reportextension',
  'query',
  'xmlport',
  'enum',
  'enumextension',
  'permissionset',
  'interface'
];

suite('al/triggers: table', () => {
  const owner: ObjectRef = { kind: 'table', id: 50100, name: 'My Table' };
  const publishers = synthesizeTriggerPublishers(owner);

  test('returns 10 publishers', () => {
    assert.strictEqual(publishers.length, 10);
  });

  test('returns every expected table trigger event name', () => {
    const names = publishers.map((p) => p.eventName).sort();
    const expected = [...EXPECTED_TABLE_EVENTS].sort();
    assert.deepStrictEqual(names, expected);
  });

  test('every publisher has kind=trigger and no location', () => {
    for (const p of publishers) {
      assert.strictEqual(p.kind, 'trigger');
      assert.strictEqual(p.location, undefined);
    }
  });

  test('every publisher carries the input owner', () => {
    for (const p of publishers) {
      assert.deepStrictEqual(p.owner, owner);
    }
  });
});

suite('al/triggers: page', () => {
  const owner: ObjectRef = { kind: 'page', id: 50200, name: 'My Page' };
  const publishers = synthesizeTriggerPublishers(owner);

  test('returns 8 publishers', () => {
    assert.strictEqual(publishers.length, 8);
  });

  test('returns every expected page trigger event name', () => {
    const names = publishers.map((p) => p.eventName).sort();
    const expected = [...EXPECTED_PAGE_EVENTS].sort();
    assert.deepStrictEqual(names, expected);
  });

  test('every publisher has kind=trigger and no location', () => {
    for (const p of publishers) {
      assert.strictEqual(p.kind, 'trigger');
      assert.strictEqual(p.location, undefined);
    }
  });

  test('every publisher carries the input owner', () => {
    for (const p of publishers) {
      assert.deepStrictEqual(p.owner, owner);
    }
  });
});

suite('al/triggers: sourceUri tagging (issue #107)', () => {
  const owner: ObjectRef = { kind: 'table', id: 50300, name: 'Tagged Table' };

  test('omitting sourceUri leaves it undefined on every emitted publisher (.app-bundled behavior)', () => {
    const publishers = synthesizeTriggerPublishers(owner);
    assert.strictEqual(publishers.length, 10);
    for (const p of publishers) {
      assert.strictEqual(p.sourceUri, undefined,
        '.app-bundled triggers must keep sourceUri: undefined so a workspace save never evicts them');
    }
  });

  test('passing sourceUri tags every emitted publisher with that exact URI (workspace-pass behavior)', () => {
    const uri = vscode.Uri.parse('file:///workspace/TaggedTable.al');
    const publishers = synthesizeTriggerPublishers(owner, uri);
    assert.strictEqual(publishers.length, 10);
    for (const p of publishers) {
      assert.ok(p.sourceUri, 'sourceUri must be set when supplied');
      assert.strictEqual(p.sourceUri!.toString(), uri.toString(),
        'every emitted publisher must carry the supplied sourceUri so the save-survival filter can evict them on re-save');
    }
  });
});

suite('al/triggers: kinds without triggers', () => {
  for (const kind of EMPTY_KINDS) {
    test(`returns [] for ${kind}`, () => {
      const owner: ObjectRef = { kind, name: 'X', id: kind === 'interface' ? undefined : 50000 };
      assert.deepStrictEqual(synthesizeTriggerPublishers(owner), []);
    });
  }
});

suite('al/triggers: collectTriggerOwners appId case-insensitivity (#130)', () => {
  const tableSrc = 'table 50300 "My Table"\n{\n}\n';

  test('same (kind, name) under appIds differing only in GUID case collapses to one owner', () => {
    const out = new Map<string, ObjectRef>();
    // GUID casing differs between app.json `id` and NavxManifest.xml `Id`;
    // the dedup key lower-cases appId so the two collate identically.
    collectTriggerOwners(tableSrc, out, 'AAAAAAAA-1111-2222-3333-444444444444');
    collectTriggerOwners(tableSrc, out, 'aaaaaaaa-1111-2222-3333-444444444444');
    assert.strictEqual(out.size, 1,
      'a case-only appId difference must not duplicate the trigger owner');
    // The emitted ObjectRef keeps its source-cased appId (first one wins);
    // only the dedup key is normalized.
    const owner = [...out.values()][0];
    assert.strictEqual(owner.appId, 'AAAAAAAA-1111-2222-3333-444444444444',
      'the surviving owner keeps its source-cased appId, not the lower-cased key');
  });

  test('genuinely distinct appIds still produce distinct owners', () => {
    const out = new Map<string, ObjectRef>();
    collectTriggerOwners(tableSrc, out, '11111111-1111-1111-1111-111111111111');
    collectTriggerOwners(tableSrc, out, '22222222-2222-2222-2222-222222222222');
    assert.strictEqual(out.size, 2,
      'different appIds must remain separate owners (scoping preserved)');
  });
});

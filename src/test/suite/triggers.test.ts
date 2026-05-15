import * as assert from 'assert';
import type { ObjectKind, ObjectRef } from '../../al/types';
import { synthesizeTriggerPublishers } from '../../al/triggers';

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

suite('al/triggers: kinds without triggers', () => {
  for (const kind of EMPTY_KINDS) {
    test(`returns [] for ${kind}`, () => {
      const owner: ObjectRef = { kind, name: 'X', id: kind === 'interface' ? undefined : 50000 };
      assert.deepStrictEqual(synthesizeTriggerPublishers(owner), []);
    });
  }
});

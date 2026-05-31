import * as assert from 'assert';
import * as vscode from 'vscode';
import type { ObjectKind, Publisher, Subscriber } from '../../al/types';
import {
  countSubscribersByPublisherKey,
  findSubscribersFor,
  publisherKey,
  subscriberKey
} from '../../index/match';

function makePublisher(
  kind: ObjectKind,
  name: string,
  eventName: string,
  appId?: string
): Publisher {
  return {
    owner: { kind, name, appId },
    eventName,
    kind: 'integration'
  };
}

function makeSubscriber(
  targetKind: ObjectKind,
  targetName: string,
  targetEvent: string
): Subscriber {
  return {
    owner: { kind: 'codeunit', name: 'Some Subscriber' },
    target: { kind: targetKind, name: targetName },
    targetEvent,
    location: new vscode.Location(vscode.Uri.parse('file:///x.al'), new vscode.Position(0, 0)),
    resolved: false
  };
}

suite('index/match: publisherKey + subscriberKey', () => {
  test('a publisher and a subscriber that target it produce the same key', () => {
    const p = makePublisher('codeunit', 'Sales-Post', 'OnAfterPostSalesDoc');
    const s = makeSubscriber('codeunit', 'Sales-Post', 'OnAfterPostSalesDoc');
    assert.strictEqual(publisherKey(p), subscriberKey(s));
  });

  test('case-insensitive on owner name', () => {
    const p = makePublisher('codeunit', 'Sales-Post', 'OnAfterPostSalesDoc');
    const s = makeSubscriber('codeunit', 'sales-POST', 'OnAfterPostSalesDoc');
    assert.strictEqual(publisherKey(p), subscriberKey(s));
  });

  test('case-insensitive on event name', () => {
    const p = makePublisher('codeunit', 'Sales-Post', 'OnAfterPostSalesDoc');
    const s = makeSubscriber('codeunit', 'Sales-Post', 'onafterpostsalesdoc');
    assert.strictEqual(publisherKey(p), subscriberKey(s));
  });

  test('different kinds produce different keys (same name, same event)', () => {
    const p = makePublisher('codeunit', 'Customer', 'OnAfterInsertEvent');
    const s = makeSubscriber('table', 'Customer', 'OnAfterInsertEvent');
    assert.notStrictEqual(publisherKey(p), subscriberKey(s));
  });

  test('space-containing name/event do not collide across the delimiter (#133)', () => {
    // Under the old single-space delimiter both produced "codeunit a b c";
    // the U+0001 delimiter keeps them distinct.
    const p = makePublisher('codeunit', 'A B', 'C');
    const s = makeSubscriber('codeunit', 'A', 'B C');
    assert.notStrictEqual(publisherKey(p), subscriberKey(s),
      'a name ending in a space-token must not collide with an event starting with one');
  });

  test('genuinely matching space-containing names still produce the same key (#133)', () => {
    const p = makePublisher('codeunit', 'My Cool Codeunit', 'On After Foo');
    const s = makeSubscriber('codeunit', 'my cool codeunit', 'on after foo');
    assert.strictEqual(publisherKey(p), subscriberKey(s),
      'the delimiter change must not break legitimate matches on names/events with spaces');
  });
});

suite('index/match: findSubscribersFor', () => {
  test('returns all subscribers whose target matches the publisher', () => {
    const p = makePublisher('codeunit', 'Sales-Post', 'OnAfterPostSalesDoc');
    const subs = [
      makeSubscriber('codeunit', 'Sales-Post', 'OnAfterPostSalesDoc'),
      makeSubscriber('codeunit', 'Sales-Post', 'OnAfterPostSalesDoc'),
      makeSubscriber('codeunit', 'Other', 'OnNothing'),
      makeSubscriber('table', 'Sales-Post', 'OnAfterPostSalesDoc')
    ];
    const matches = findSubscribersFor(p, subs);
    assert.strictEqual(matches.length, 2);
  });

  test('returns [] when nothing matches', () => {
    const p = makePublisher('codeunit', 'Sales-Post', 'OnAfterPostSalesDoc');
    assert.deepStrictEqual(findSubscribersFor(p, []), []);
    assert.deepStrictEqual(
      findSubscribersFor(p, [makeSubscriber('codeunit', 'Other', 'OnFoo')]),
      []
    );
  });
});

suite('index/match: countSubscribersByPublisherKey', () => {
  test('counts per (target.kind, target.name, targetEvent) triple', () => {
    const subs = [
      makeSubscriber('codeunit', 'A', 'OnFoo'),
      makeSubscriber('codeunit', 'A', 'OnFoo'),
      makeSubscriber('codeunit', 'A', 'OnFoo'),
      makeSubscriber('codeunit', 'B', 'OnBar'),
      makeSubscriber('table', 'A', 'OnFoo')
    ];
    const counts = countSubscribersByPublisherKey(subs);
    assert.strictEqual(counts.get(publisherKey(makePublisher('codeunit', 'A', 'OnFoo'))), 3);
    assert.strictEqual(counts.get(publisherKey(makePublisher('codeunit', 'B', 'OnBar'))), 1);
    assert.strictEqual(counts.get(publisherKey(makePublisher('table', 'A', 'OnFoo'))), 1);
  });

  test('case-insensitive bucketing — "FOO" and "foo" land in the same bucket', () => {
    const subs = [
      makeSubscriber('codeunit', 'Sales-Post', 'OnFoo'),
      makeSubscriber('codeunit', 'sales-post', 'onfoo'),
      makeSubscriber('codeunit', 'SALES-POST', 'OnFoo')
    ];
    const counts = countSubscribersByPublisherKey(subs);
    assert.strictEqual(counts.size, 1);
    const only = Array.from(counts.values())[0];
    assert.strictEqual(only, 3);
  });

  test('empty input returns an empty map', () => {
    assert.strictEqual(countSubscribersByPublisherKey([]).size, 0);
  });
});

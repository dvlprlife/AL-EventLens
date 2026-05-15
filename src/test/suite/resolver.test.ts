import * as assert from 'assert';
import * as vscode from 'vscode';
import type { EventKind, ObjectKind, Publisher, Subscriber } from '../../al/types';
import { resolveSubscribers } from '../../index/resolver';

function makePublisher(
  kind: ObjectKind,
  name: string,
  eventName: string,
  opts?: { kind?: EventKind; appId?: string }
): Publisher {
  return {
    owner: { kind, name, appId: opts?.appId },
    eventName,
    kind: opts?.kind ?? 'integration'
  };
}

function makeSubscriber(
  targetKind: ObjectKind,
  targetName: string,
  targetEvent: string,
  opts?: { ownerName?: string; targetAppId?: string; resolved?: boolean }
): Subscriber {
  return {
    owner: { kind: 'codeunit', name: opts?.ownerName ?? 'My Subscriber Codeunit' },
    target: { kind: targetKind, name: targetName, appId: opts?.targetAppId },
    targetEvent,
    location: new vscode.Location(vscode.Uri.parse('file:///x.al'), new vscode.Position(0, 0)),
    resolved: opts?.resolved ?? false
  };
}

suite('resolveSubscribers', () => {
  test('exact match resolves', () => {
    const publishers = [makePublisher('codeunit', 'Sales-Post', 'OnAfterPostSalesDoc')];
    const subscribers = [makeSubscriber('codeunit', 'Sales-Post', 'OnAfterPostSalesDoc')];
    const result = resolveSubscribers(publishers, subscribers);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].resolved, true);
  });

  test('case-mismatched name resolves', () => {
    const publishers = [makePublisher('codeunit', 'Sales-Post', 'OnAfterPostSalesDoc')];
    const subscribers = [makeSubscriber('codeunit', 'sales-post', 'OnAfterPostSalesDoc')];
    const result = resolveSubscribers(publishers, subscribers);
    assert.strictEqual(result[0].resolved, true);
  });

  test('case-mismatched event name resolves', () => {
    const publishers = [makePublisher('codeunit', 'Sales-Post', 'OnAfterPostSalesDoc')];
    const subscribers = [makeSubscriber('codeunit', 'Sales-Post', 'onafterpostsalesdoc')];
    const result = resolveSubscribers(publishers, subscribers);
    assert.strictEqual(result[0].resolved, true);
  });

  test('missing publisher leaves resolved: false', () => {
    const subscribers = [makeSubscriber('codeunit', 'Sales-Post', 'OnAfterPostSalesDoc')];
    const result = resolveSubscribers([], subscribers);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].resolved, false);
  });

  test('trigger publisher resolves a subscriber to that trigger', () => {
    const publishers = [
      makePublisher('table', 'Customer', 'OnAfterInsertEvent', { kind: 'trigger' })
    ];
    const subscribers = [makeSubscriber('table', 'Customer', 'OnAfterInsertEvent')];
    const result = resolveSubscribers(publishers, subscribers);
    assert.strictEqual(result[0].resolved, true);
  });

  test('multiple publishers with same triple across different apps — first wins', () => {
    const publishers = [
      makePublisher('codeunit', 'Sales-Post', 'OnAfterPostSalesDoc', { appId: 'app-a' }),
      makePublisher('codeunit', 'Sales-Post', 'OnAfterPostSalesDoc', { appId: 'app-b' })
    ];
    const subscribers = [makeSubscriber('codeunit', 'Sales-Post', 'OnAfterPostSalesDoc')];
    const result = resolveSubscribers(publishers, subscribers);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].resolved, true);
  });

  test("subscriber's target.appId does not affect matching", () => {
    const publishers = [makePublisher('codeunit', 'Sales-Post', 'OnAfterPostSalesDoc')];
    const subscribers = [
      makeSubscriber('codeunit', 'Sales-Post', 'OnAfterPostSalesDoc', {
        targetAppId: '00000000-0000-0000-0000-000000000001'
      })
    ];
    const result = resolveSubscribers(publishers, subscribers);
    assert.strictEqual(result[0].resolved, true);
  });

  test('empty publishers array returns subscribers with all resolved: false', () => {
    const subscribers = [
      makeSubscriber('codeunit', 'A', 'OnFoo'),
      makeSubscriber('table', 'B', 'OnBar')
    ];
    const result = resolveSubscribers([], subscribers);
    assert.strictEqual(result.length, 2);
    for (const s of result) {
      assert.strictEqual(s.resolved, false);
    }
  });

  test('empty subscribers array returns []', () => {
    const publishers = [makePublisher('codeunit', 'Sales-Post', 'OnAfterPostSalesDoc')];
    const result = resolveSubscribers(publishers, []);
    assert.deepStrictEqual(result, []);
  });

  test('input arrays are not mutated', () => {
    const publishers = [makePublisher('codeunit', 'Sales-Post', 'OnAfterPostSalesDoc')];
    const subscribers = [
      makeSubscriber('codeunit', 'Sales-Post', 'OnAfterPostSalesDoc'),
      makeSubscriber('codeunit', 'Other', 'OnNothing')
    ];
    const originalPublishersLen = publishers.length;
    const originalSubscribersLen = subscribers.length;
    const originalResolved = subscribers.map((s) => s.resolved);

    const result = resolveSubscribers(publishers, subscribers);

    assert.strictEqual(publishers.length, originalPublishersLen);
    assert.strictEqual(subscribers.length, originalSubscribersLen);
    for (let i = 0; i < subscribers.length; i++) {
      assert.strictEqual(subscribers[i].resolved, originalResolved[i]);
    }
    assert.notStrictEqual(result as unknown, subscribers as unknown);
  });

  test('idempotency (no flicker) — re-running on resolved output yields identical flags', () => {
    const publishers = [makePublisher('codeunit', 'Sales-Post', 'OnAfterPostSalesDoc')];
    const subscribers = [
      makeSubscriber('codeunit', 'Sales-Post', 'OnAfterPostSalesDoc'),
      makeSubscriber('codeunit', 'Other', 'OnNothing')
    ];
    const firstPass = resolveSubscribers(publishers, subscribers);
    const secondPass = resolveSubscribers(publishers, firstPass);
    assert.strictEqual(secondPass.length, firstPass.length);
    for (let i = 0; i < firstPass.length; i++) {
      assert.strictEqual(secondPass[i].resolved, firstPass[i].resolved);
    }
  });
});

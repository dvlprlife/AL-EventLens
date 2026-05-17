import * as assert from 'assert';
import * as vscode from 'vscode';
import type { ObjectKind, Publisher, Subscriber } from '../../al/types';
import { renderMermaid } from '../../ui/mermaid';

function makePublisher(
  kind: ObjectKind,
  name: string,
  eventName: string
): Publisher {
  return {
    owner: { kind, name },
    eventName,
    kind: 'integration'
  };
}

function makeSubscriber(opts: {
  ownerKind?: ObjectKind;
  ownerName: string;
  ownerAppId?: string;
  targetName?: string;
  targetEvent?: string;
  line?: number;
  resolved?: boolean;
}): Subscriber {
  return {
    owner: { kind: opts.ownerKind ?? 'codeunit', name: opts.ownerName, appId: opts.ownerAppId },
    target: { kind: 'codeunit', name: opts.targetName ?? 'Sales-Post' },
    targetEvent: opts.targetEvent ?? 'OnAfterPostSalesDoc',
    location: new vscode.Location(
      vscode.Uri.parse('file:///x.al'),
      new vscode.Position(opts.line ?? 0, 0)
    ),
    resolved: opts.resolved ?? true
  };
}

suite('ui/mermaid: renderMermaid', () => {
  test('output starts with "graph LR\\n" and ends with a trailing newline', () => {
    const p = makePublisher('codeunit', 'Sales-Post', 'OnAfterPostSalesDoc');
    const out = renderMermaid(p, []);
    assert.ok(out.startsWith('graph LR\n'), `expected leading 'graph LR\\n', got: ${JSON.stringify(out.slice(0, 20))}`);
    assert.ok(out.endsWith('\n'), 'expected trailing newline');
  });

  test('zero subscribers produces just the P node (no edges)', () => {
    const p = makePublisher('codeunit', 'Sales-Post', 'OnAfterPostSalesDoc');
    const out = renderMermaid(p, []);
    assert.ok(/^\s+P\[".*"\]$/m.test(out), 'expected a P[...] node line');
    assert.ok(!/-->/.test(out), 'expected no solid edges');
    assert.ok(!/-\.->/.test(out), 'expected no dotted edges');
    assert.ok(!/^\s+S\d+\[/m.test(out), 'expected no SN nodes');
  });

  test('node IDs are P and S1..SN, edges follow in order', () => {
    const p = makePublisher('codeunit', 'Sales-Post', 'OnAfterPostSalesDoc');
    const subs = [
      makeSubscriber({ ownerName: 'AAA Handler', line: 0 }),
      makeSubscriber({ ownerName: 'BBB Handler', line: 0 }),
      makeSubscriber({ ownerName: 'CCC Handler', line: 0 })
    ];
    const out = renderMermaid(p, subs);
    assert.ok(out.includes('S1["'), 'has S1 node');
    assert.ok(out.includes('S2["'), 'has S2 node');
    assert.ok(out.includes('S3["'), 'has S3 node');
    assert.ok(!out.includes('S0['), 'no S0 node');
    assert.ok(!out.includes('S4['), 'no S4 node');
    assert.ok(out.includes('P --> S1'), 'has P --> S1 edge');
    assert.ok(out.includes('P --> S2'), 'has P --> S2 edge');
    assert.ok(out.includes('P --> S3'), 'has P --> S3 edge');
  });

  test('resolved subscribers use "-->", unresolved use "-.->"', () => {
    const p = makePublisher('codeunit', 'Sales-Post', 'OnAfterPostSalesDoc');
    const subs = [
      makeSubscriber({ ownerName: 'Resolved One', resolved: true }),
      makeSubscriber({ ownerName: 'Unresolved One', resolved: false })
    ];
    const out = renderMermaid(p, subs);
    // S1 is "Resolved One" (alphabetical sort), S2 is "Unresolved One"
    assert.ok(/P --> S1\b/.test(out), `expected solid edge for S1, got:\n${out}`);
    assert.ok(/P -\.-> S2\b/.test(out), `expected dotted edge for S2, got:\n${out}`);
  });

  test('subscribers sorted by (appId, kind, name, line) — re-export is byte-identical', () => {
    const p = makePublisher('codeunit', 'Sales-Post', 'OnAfterPostSalesDoc');
    const a = makeSubscriber({ ownerName: 'Alpha', ownerAppId: 'app-x', line: 5 });
    const b = makeSubscriber({ ownerName: 'Beta', ownerAppId: 'app-x', line: 5 });
    const c = makeSubscriber({ ownerName: 'Gamma', ownerAppId: 'app-y', line: 5 });
    const firstOrder = renderMermaid(p, [a, b, c]);
    const reverseOrder = renderMermaid(p, [c, b, a]);
    assert.strictEqual(firstOrder, reverseOrder, 'output must not depend on input order');

    const order = ['Alpha', 'Beta', 'Gamma'];
    const indices = order.map((name) => firstOrder.indexOf(name));
    assert.deepStrictEqual([...indices].sort((x, y) => x - y), indices,
      `expected Alpha < Beta < Gamma in output; got positions ${indices}`);
  });

  test('subscribers in the same codeunit on different lines are disambiguated by line', () => {
    const p = makePublisher('codeunit', 'Sales-Post', 'OnAfterPostSalesDoc');
    const earlier = makeSubscriber({ ownerName: 'Same Codeunit', line: 9 });   // → :10
    const later   = makeSubscriber({ ownerName: 'Same Codeunit', line: 41 });  // → :42
    const out = renderMermaid(p, [later, earlier]); // input reversed
    const i10 = out.indexOf(':10');
    const i42 = out.indexOf(':42');
    assert.ok(i10 > -1 && i42 > -1, 'both line markers present');
    assert.ok(i10 < i42, `expected :10 before :42, got positions ${i10} / ${i42}`);
  });

  test('labels escape double quotes as &quot;', () => {
    const p = makePublisher('codeunit', 'Has "Quotes" Inside', 'OnAfterPostSalesDoc');
    const out = renderMermaid(p, []);
    assert.ok(out.includes('&quot;Quotes&quot;'),
      `expected &quot; escape for inner quotes; got:\n${out}`);
    assert.ok(!/Has "Quotes" Inside/.test(out),
      'raw " characters must not appear inside the label payload');
  });

  test('publisher label includes Kind::"Name"<br/>EventName', () => {
    const p = makePublisher('codeunit', 'Sales-Post', 'OnAfterPostSalesDoc');
    const out = renderMermaid(p, []);
    assert.ok(out.includes('Codeunit::&quot;Sales-Post&quot;<br/>OnAfterPostSalesDoc'),
      `expected formatted publisher label; got:\n${out}`);
  });

  test('subscriber label includes Kind::"Name"<br/>:Line', () => {
    const p = makePublisher('codeunit', 'Sales-Post', 'OnAfterPostSalesDoc');
    const s = makeSubscriber({ ownerName: 'MyExt Handler', line: 41 });
    const out = renderMermaid(p, [s]);
    assert.ok(out.includes('Codeunit::&quot;MyExt Handler&quot;<br/>:42'),
      `expected formatted subscriber label with 1-based line; got:\n${out}`);
  });
});

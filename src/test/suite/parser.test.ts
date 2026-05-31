import * as assert from 'assert';
import * as vscode from 'vscode';
import { parseAl } from '../../al/parser';

const uri = vscode.Uri.parse('untitled:test.al');

suite('al/parser: publishers', () => {
  test('IntegrationEvent without attribute parameters', () => {
    const src = [
      'codeunit 50100 "My Codeunit"',
      '{',
      '    [IntegrationEvent]',
      '    procedure OnAfterFoo()',
      '    begin',
      '    end;',
      '}'
    ].join('\n');
    const { publishers, subscribers } = parseAl(uri, src);
    assert.strictEqual(subscribers.length, 0);
    assert.strictEqual(publishers.length, 1);
    assert.strictEqual(publishers[0].eventName, 'OnAfterFoo');
    assert.strictEqual(publishers[0].kind, 'integration');
    assert.strictEqual(publishers[0].owner.kind, 'codeunit');
    assert.strictEqual(publishers[0].owner.id, 50100);
    assert.strictEqual(publishers[0].owner.name, 'My Codeunit');
  });

  test('IntegrationEvent with attribute parameters', () => {
    const src = [
      'codeunit 50100 MyCu',
      '{',
      '    [IntegrationEvent(false, false)]',
      '    procedure OnAfterFoo()',
      '    begin',
      '    end;',
      '}'
    ].join('\n');
    const { publishers } = parseAl(uri, src);
    assert.strictEqual(publishers.length, 1);
    assert.strictEqual(publishers[0].eventName, 'OnAfterFoo');
    assert.strictEqual(publishers[0].owner.name, 'MyCu');
  });

  test('BusinessEvent recognized with business kind', () => {
    const src = [
      'codeunit 50101 "Biz Codeunit"',
      '{',
      '    [BusinessEvent(false)]',
      '    procedure OnSomethingBusinessy()',
      '    begin',
      '    end;',
      '}'
    ].join('\n');
    const { publishers } = parseAl(uri, src);
    assert.strictEqual(publishers.length, 1);
    assert.strictEqual(publishers[0].kind, 'business');
    assert.strictEqual(publishers[0].eventName, 'OnSomethingBusinessy');
  });

  test('source location points at the procedure name', () => {
    const src = [
      'codeunit 50100 "C"',                  // line 0
      '{',                                   // line 1
      '    [IntegrationEvent(false, false)]', // line 2
      '    procedure OnAfterFoo()',          // line 3
      '    begin',                           // line 4
      '    end;',                            // line 5
      '}'                                    // line 6
    ].join('\n');
    const { publishers } = parseAl(uri, src);
    assert.strictEqual(publishers.length, 1);
    const loc = publishers[0].location!;
    assert.strictEqual(loc.range.start.line, 3);
    assert.strictEqual(loc.range.start.character, 14); // column of "OnAfterFoo"
  });

  test('multiple stacked attributes do not duplicate the publisher', () => {
    const src = [
      'codeunit 50100 "C"',
      '{',
      '    [Scope(\'OnPrem\')]',
      '    [IntegrationEvent(false, false)]',
      '    procedure OnAfterFoo()',
      '    begin',
      '    end;',
      '}'
    ].join('\n');
    const { publishers } = parseAl(uri, src);
    assert.strictEqual(publishers.length, 1);
    assert.strictEqual(publishers[0].eventName, 'OnAfterFoo');
  });
});

suite('al/parser: publisher parameters', () => {
  test('zero-arg procedure → empty parameters array', () => {
    const src = [
      'codeunit 50100 "C"',
      '{',
      '    [IntegrationEvent(false, false)]',
      '    procedure OnAfterFoo()',
      '    begin',
      '    end;',
      '}'
    ].join('\n');
    const { publishers } = parseAl(uri, src);
    assert.deepStrictEqual(publishers[0].parameters, []);
  });

  test('typical BC signature: var Record subtype + Boolean', () => {
    const src = [
      'codeunit 50100 "C"',
      '{',
      '    [IntegrationEvent(false, false)]',
      '    procedure OnAfterPostSalesOrder(var SalesHeader: Record "Sales Header"; CommitIsSuppressed: Boolean)',
      '    begin',
      '    end;',
      '}'
    ].join('\n');
    const { publishers } = parseAl(uri, src);
    assert.deepStrictEqual(publishers[0].parameters, [
      { name: 'SalesHeader', typeText: 'Record "Sales Header"', isVar: true },
      { name: 'CommitIsSuppressed', typeText: 'Boolean', isVar: false }
    ]);
  });

  test('multi-line parameter list', () => {
    const src = [
      'codeunit 50100 "C"',
      '{',
      '    [IntegrationEvent(false, false)]',
      '    procedure OnAfterPostSalesOrder(',
      '        var SalesHeader: Record "Sales Header";',
      '        var SalesInvoiceHeader: Record "Sales Invoice Header";',
      '        CommitIsSuppressed: Boolean',
      '    )',
      '    begin',
      '    end;',
      '}'
    ].join('\n');
    const { publishers } = parseAl(uri, src);
    assert.strictEqual(publishers[0].parameters!.length, 3);
    assert.deepStrictEqual(publishers[0].parameters![0], {
      name: 'SalesHeader', typeText: 'Record "Sales Header"', isVar: true
    });
    assert.deepStrictEqual(publishers[0].parameters![2], {
      name: 'CommitIsSuppressed', typeText: 'Boolean', isVar: false
    });
  });

  test('length-bound types: Code[20] and Text[50]', () => {
    const src = [
      'codeunit 50100 "C"',
      '{',
      '    [IntegrationEvent(false, false)]',
      '    procedure OnLookup(No: Code[20]; Description: Text[50])',
      '    begin',
      '    end;',
      '}'
    ].join('\n');
    const { publishers } = parseAl(uri, src);
    assert.deepStrictEqual(publishers[0].parameters, [
      { name: 'No', typeText: 'Code[20]', isVar: false },
      { name: 'Description', typeText: 'Text[50]', isVar: false }
    ]);
  });

  test('quoted parameter name is unquoted; brackets in type do not split params', () => {
    // `;` inside a `Dictionary of [Code[20]; Text]` type expression must not
    // be treated as a parameter separator. Also exercises a quoted name.
    const src = [
      'codeunit 50100 "C"',
      '{',
      '    [IntegrationEvent(false, false)]',
      '    procedure OnEvt("My Param": Dictionary of [Code[20]; Text]; Flag: Boolean)',
      '    begin',
      '    end;',
      '}'
    ].join('\n');
    const { publishers } = parseAl(uri, src);
    assert.deepStrictEqual(publishers[0].parameters, [
      { name: 'My Param', typeText: 'Dictionary of [Code[20]; Text]', isVar: false },
      { name: 'Flag', typeText: 'Boolean', isVar: false }
    ]);
  });

  test('return type after parameters does not bleed into the last param', () => {
    const src = [
      'codeunit 50100 "C"',
      '{',
      '    [IntegrationEvent(false, false)]',
      '    procedure GetSomething(Id: Integer): Code[20]',
      '    begin',
      '    end;',
      '}'
    ].join('\n');
    const { publishers } = parseAl(uri, src);
    assert.deepStrictEqual(publishers[0].parameters, [
      { name: 'Id', typeText: 'Integer', isVar: false }
    ]);
  });
});

suite('al/parser: subscribers', () => {
  test('pre-BC22 syntax (string-literal target name and quoted event)', () => {
    const src = [
      'codeunit 50200 "Subscriber Cu"',
      '{',
      '    [EventSubscriber(ObjectType::Codeunit, Codeunit::\'Sales Post\', \'OnAfterPostSalesDoc\', \'\', false, false)]',
      '    local procedure HandleIt()',
      '    begin',
      '    end;',
      '}'
    ].join('\n');
    const { subscribers } = parseAl(uri, src);
    assert.strictEqual(subscribers.length, 1);
    assert.strictEqual(subscribers[0].target.kind, 'codeunit');
    assert.strictEqual(subscribers[0].target.name, 'Sales Post');
    assert.strictEqual(subscribers[0].targetEvent, 'OnAfterPostSalesDoc');
    assert.strictEqual(subscribers[0].resolved, false);
    assert.strictEqual(subscribers[0].owner.kind, 'codeunit');
    assert.strictEqual(subscribers[0].owner.id, 50200);
  });

  test('BC22+ syntax (quoted target name, bare event identifier)', () => {
    const src = [
      'codeunit 50201 "Subscriber Cu"',
      '{',
      '    [EventSubscriber(ObjectType::Codeunit, Codeunit::"Sales-Post", OnAfterPostSalesDoc, \'\', false, false)]',
      '    local procedure HandleIt()',
      '    begin',
      '    end;',
      '}'
    ].join('\n');
    const { subscribers } = parseAl(uri, src);
    assert.strictEqual(subscribers.length, 1);
    assert.strictEqual(subscribers[0].target.name, 'Sales-Post');
    assert.strictEqual(subscribers[0].targetEvent, 'OnAfterPostSalesDoc');
  });

  test('BC22+ syntax with bare-identifier target name', () => {
    const src = [
      'codeunit 50202 MySub',
      '{',
      '    [EventSubscriber(ObjectType::Table, Table::Customer, OnAfterModify, \'\', false, false)]',
      '    local procedure HandleIt()',
      '    begin',
      '    end;',
      '}'
    ].join('\n');
    const { subscribers } = parseAl(uri, src);
    assert.strictEqual(subscribers.length, 1);
    assert.strictEqual(subscribers[0].target.kind, 'table');
    assert.strictEqual(subscribers[0].target.name, 'Customer');
    assert.strictEqual(subscribers[0].targetEvent, 'OnAfterModify');
  });

  test('subscriber attribute wrapped across lines', () => {
    const src = [
      'codeunit 50203 "Multi Line Sub"',
      '{',
      '    [EventSubscriber(ObjectType::Codeunit, Codeunit::\'Sales Post\',',
      '                     \'OnAfterPostSalesDoc\', \'\', false, false)]',
      '    local procedure HandleIt()',
      '    begin',
      '    end;',
      '}'
    ].join('\n');
    const { subscribers } = parseAl(uri, src);
    assert.strictEqual(subscribers.length, 1);
    assert.strictEqual(subscribers[0].target.name, 'Sales Post');
    assert.strictEqual(subscribers[0].targetEvent, 'OnAfterPostSalesDoc');
  });
});

suite('al/parser: mixed and edge cases', () => {
  test('publisher and subscriber in the same file', () => {
    const src = [
      'codeunit 50300 "Mixed Cu"',
      '{',
      '    [IntegrationEvent(false, false)]',
      '    procedure OnAfterFoo()',
      '    begin',
      '    end;',
      '',
      '    [EventSubscriber(ObjectType::Codeunit, Codeunit::"Sales-Post", OnAfterPostSalesDoc, \'\', false, false)]',
      '    local procedure HandleIt()',
      '    begin',
      '    end;',
      '}'
    ].join('\n');
    const { publishers, subscribers } = parseAl(uri, src);
    assert.strictEqual(publishers.length, 1);
    assert.strictEqual(subscribers.length, 1);
    assert.strictEqual(publishers[0].eventName, 'OnAfterFoo');
    assert.strictEqual(subscribers[0].targetEvent, 'OnAfterPostSalesDoc');
  });

  test('attribute in a // comment is ignored', () => {
    const src = [
      'codeunit 50400 "C"',
      '{',
      '    // [IntegrationEvent(false, false)]',
      '    // describes a fake publisher',
      '    procedure NotAPublisher()',
      '    begin',
      '    end;',
      '',
      '    [IntegrationEvent(false, false)]',
      '    procedure RealPublisher()',
      '    begin',
      '    end;',
      '}'
    ].join('\n');
    const { publishers } = parseAl(uri, src);
    assert.strictEqual(publishers.length, 1);
    assert.strictEqual(publishers[0].eventName, 'RealPublisher');
  });

  test('attribute in a /* block comment */ is ignored', () => {
    const src = [
      'codeunit 50401 "C"',
      '{',
      '    /* an example of how to subscribe:',
      '       [EventSubscriber(ObjectType::Codeunit, Codeunit::\'Sales Post\', \'OnX\', \'\', false, false)]',
      '       local procedure WouldBeASub() begin end;',
      '    */',
      '    [IntegrationEvent(false, false)]',
      '    procedure RealPublisher()',
      '    begin',
      '    end;',
      '}'
    ].join('\n');
    const { publishers, subscribers } = parseAl(uri, src);
    assert.strictEqual(subscribers.length, 0);
    assert.strictEqual(publishers.length, 1);
    assert.strictEqual(publishers[0].eventName, 'RealPublisher');
  });

  test("'/*' inside a single-quoted string does not start a block comment", () => {
    const src = [
      'codeunit 50402 "C"',
      '{',
      '    procedure Progress()',
      '    begin',
      "        Message('progress: /* 50%');",
      '    end;',
      '',
      '    [IntegrationEvent(false, false)]',
      '    procedure RealPublisher()',
      '    begin',
      '    end;',
      '',
      '    /* trailing note */',
      '}'
    ].join('\n');
    const { publishers } = parseAl(uri, src);
    assert.strictEqual(publishers.length, 1);
    assert.strictEqual(publishers[0].eventName, 'RealPublisher');
  });

  test("'//' inside a single-quoted string does not start a line comment", () => {
    const src = [
      'codeunit 50403 "C"',
      '{',
      "    [EventSubscriber(ObjectType::Codeunit, Codeunit::\"Sales-Post\", OnAfterPostSalesDoc, 'https://x//y', false, false)]",
      '    local procedure HandleIt()',
      '    begin',
      '    end;',
      '}'
    ].join('\n');
    const { subscribers } = parseAl(uri, src);
    assert.strictEqual(subscribers.length, 1);
    assert.strictEqual(subscribers[0].targetEvent, 'OnAfterPostSalesDoc');
  });

  test("quoted identifier containing // or /* is not treated as a comment", () => {
    const src = [
      'codeunit 50410 "Weird // Name /* x"',
      '{',
      '    [IntegrationEvent(false, false)]',
      '    procedure OnX()',
      '    begin',
      '    end;',
      '}'
    ].join('\n');
    const { publishers } = parseAl(uri, src);
    assert.strictEqual(publishers.length, 1);
    assert.strictEqual(publishers[0].eventName, 'OnX');
    assert.strictEqual(publishers[0].owner.name, 'Weird // Name /* x');
  });

  test('multi-object file (codeunit + tableextension) attributes attribute to the correct owner', () => {
    const src = [
      'codeunit 50500 "Cu Owner"',
      '{',
      '    [IntegrationEvent(false, false)]',
      '    procedure OnFromCu()',
      '    begin',
      '    end;',
      '}',
      '',
      'tableextension 50501 "Cust Ext" extends Customer',
      '{',
      '    [IntegrationEvent(false, false)]',
      '    procedure OnFromTableExt()',
      '    begin',
      '    end;',
      '}'
    ].join('\n');
    const { publishers } = parseAl(uri, src);
    assert.strictEqual(publishers.length, 2);
    const fromCu = publishers.find(p => p.eventName === 'OnFromCu');
    const fromExt = publishers.find(p => p.eventName === 'OnFromTableExt');
    assert.ok(fromCu);
    assert.ok(fromExt);
    assert.strictEqual(fromCu!.owner.kind, 'codeunit');
    assert.strictEqual(fromCu!.owner.name, 'Cu Owner');
    assert.strictEqual(fromExt!.owner.kind, 'tableextension');
    assert.strictEqual(fromExt!.owner.name, 'Cust Ext');
    assert.strictEqual(fromExt!.owner.id, 50501);
  });

  test('quoted object names with spaces and hyphens round-trip correctly', () => {
    const src = [
      'codeunit 50600 "My-Awesome Codeunit With Spaces"',
      '{',
      '    [IntegrationEvent(false, false)]',
      '    procedure OnX()',
      '    begin',
      '    end;',
      '}'
    ].join('\n');
    const { publishers } = parseAl(uri, src);
    assert.strictEqual(publishers.length, 1);
    assert.strictEqual(publishers[0].owner.name, 'My-Awesome Codeunit With Spaces');
  });

  test('interface object kind (no id) is recognized as owner', () => {
    const src = [
      'interface "IMyInterface"',
      '{',
      '    [IntegrationEvent(false, false)]',
      '    procedure OnX()',
      '    begin',
      '    end;',
      '}'
    ].join('\n');
    const { publishers } = parseAl(uri, src);
    assert.strictEqual(publishers.length, 1);
    assert.strictEqual(publishers[0].owner.kind, 'interface');
    assert.strictEqual(publishers[0].owner.id, undefined);
    assert.strictEqual(publishers[0].owner.name, 'IMyInterface');
  });

  test('file with no objects returns empty arrays', () => {
    const src = '// just a comment, no objects here';
    const { publishers, subscribers } = parseAl(uri, src);
    assert.strictEqual(publishers.length, 0);
    assert.strictEqual(subscribers.length, 0);
  });

  test('CRLF line endings parse the same as LF', () => {
    const src = [
      'codeunit 50700 "CRLF Cu"',
      '{',
      '    [IntegrationEvent(false, false)]',
      '    procedure OnX()',
      '    begin',
      '    end;',
      '}'
    ].join('\r\n');
    const { publishers } = parseAl(uri, src);
    assert.strictEqual(publishers.length, 1);
    assert.strictEqual(publishers[0].eventName, 'OnX');
  });
});

suite('al/parser: procedure-search window (#125)', () => {
  // The keyword search in findProcedureAfter is bounded to
  // PROCEDURE_SEARCH_WINDOW (2048) chars past the attribute. These tests
  // pin that the bound never affects valid AL (where `procedure` follows the
  // attribute closely and signatures parse in full) while a procedure-less
  // tail no longer drives an O(N x tail) scan.

  test('procedure a few hundred chars below the attribute still resolves within the window', () => {
    // A realistic gap (doc comments / blank lines) between the event
    // attribute and `procedure`. Comments are stripped to blanks but still
    // consume window distance; 20 lines is well under 2048 chars.
    const gap = Array.from({ length: 20 }, (_, i) => `    // doc line ${i}`);
    const src = [
      'codeunit 50100 "C"',
      '{',
      '    [IntegrationEvent(false, false)]',
      ...gap,
      '    procedure OnAfterFoo()',
      '    begin',
      '    end;',
      '}'
    ].join('\n');
    const { publishers } = parseAl(uri, src);
    assert.strictEqual(publishers.length, 1);
    assert.strictEqual(publishers[0].eventName, 'OnAfterFoo');
  });

  test('long parameter list extending past the window still parses in full', () => {
    // `procedure` is found immediately (within the window), but the closing
    // paren sits ~3.5 KB past the attribute — beyond PROCEDURE_SEARCH_WINDOW.
    // parseParameterListAt scans the full text, so all params must parse,
    // proving the window bounds only the keyword search, not the signature.
    const count = 80;
    const params = Array.from({ length: count }, (_, i) =>
      `        var Param${i}: Record "Sales Header"` + (i < count - 1 ? ';' : ''));
    const src = [
      'codeunit 50100 "C"',
      '{',
      '    [IntegrationEvent(false, false)]',
      '    procedure OnAfterPostManyArgs(',
      ...params,
      '    )',
      '    begin',
      '    end;',
      '}'
    ].join('\n');
    const { publishers } = parseAl(uri, src);
    assert.strictEqual(publishers.length, 1);
    assert.strictEqual(publishers[0].eventName, 'OnAfterPostManyArgs');
    assert.strictEqual(publishers[0].parameters!.length, count);
    assert.strictEqual(publishers[0].parameters![count - 1].name, `Param${count - 1}`);
  });

  test('many procedure-less attribute markers + large tail parse fast and bind nothing', () => {
    // Pre-fix every one of the N orphan attributes scanned the whole tail
    // for `procedure`, an O(N x tail) blow-up (~7.5 s at 40k markers per
    // issue #125) — and each orphan bound to the single trailing procedure,
    // producing N+1 publishers. The procedure-less tail (> 2048 chars) keeps
    // even the last orphan's window from reaching the real procedure, so the
    // bounded scan yields exactly one publisher and runs in single-digit ms.
    const N = 20000;
    const lines: string[] = ['codeunit 50100 "Perf Cu"', '{'];
    for (let i = 0; i < N; i++) {
      lines.push('    [IntegrationEvent(false, false)]');
    }
    for (let i = 0; i < 200; i++) {
      lines.push(`    // procedure-less tail filler ${i}`);
    }
    lines.push('    [IntegrationEvent(false, false)]');
    lines.push('    procedure OnRealEvent()');
    lines.push('    begin');
    lines.push('    end;');
    lines.push('}');
    const src = lines.join('\n');

    const start = Date.now();
    const { publishers } = parseAl(uri, src);
    const elapsedMs = Date.now() - start;

    assert.strictEqual(publishers.length, 1);
    assert.strictEqual(publishers[0].eventName, 'OnRealEvent');
    // Loose ceiling, far above the bounded-scan cost yet far below the
    // pre-fix multi-second blow-up; runs by default without flaking on CI.
    assert.ok(elapsedMs < 2000, `parseAl took ${elapsedMs}ms (expected < 2000ms)`);
  });
});

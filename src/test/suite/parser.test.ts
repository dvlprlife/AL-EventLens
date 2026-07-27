import * as assert from 'assert';
import * as vscode from 'vscode';
import { parseAl, stripComments } from '../../al/parser';

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

  test('quoted name/type containing ; ( ) does not truncate or mis-split the list (#133)', () => {
    const src = [
      'codeunit 50100 "C"',
      '{',
      '    [IntegrationEvent(false, false)]',
      '    procedure OnFoo(var Rec: Record "Weird ; Name"; "Quoted (Param)": Integer)',
      '    begin',
      '    end;',
      '}'
    ].join('\n');
    const { publishers } = parseAl(uri, src);
    assert.strictEqual(publishers.length, 1);
    // The `;` inside "Weird ; Name" must not split the list, and the `(`/`)`
    // inside "Quoted (Param)" must not close the parameter list early.
    assert.deepStrictEqual(publishers[0].parameters, [
      { name: 'Rec', typeText: 'Record "Weird ; Name"', isVar: true },
      { name: 'Quoted (Param)', typeText: 'Integer', isVar: false }
    ]);
  });

  test('quoted parameter name containing a colon is not split (#184 D2)', () => {
    // #133 made the paren-matching and semicolon-splitting scanners skip
    // `"…"` spans but left the `Name : Type` split quote-blind, so this
    // parsed as name `"My`, type `Param": Integer`.
    const src = [
      'codeunit 50100 "C"',
      '{',
      '    [IntegrationEvent(false, false)]',
      '    procedure OnEvt("My:Param": Integer; Flag: Boolean)',
      '    begin',
      '    end;',
      '}'
    ].join('\n');
    const { publishers } = parseAl(uri, src);
    assert.deepStrictEqual(publishers[0].parameters, [
      { name: 'My:Param', typeText: 'Integer', isVar: false },
      { name: 'Flag', typeText: 'Boolean', isVar: false }
    ]);
  });

  test('var + a quoted colon-bearing parameter name (#184 D2)', () => {
    const src = [
      'codeunit 50100 "C"',
      '{',
      '    [IntegrationEvent(false, false)]',
      '    procedure OnEvt(var "A:B": Record "Sales Header")',
      '    begin',
      '    end;',
      '}'
    ].join('\n');
    const { publishers } = parseAl(uri, src);
    assert.deepStrictEqual(publishers[0].parameters, [
      { name: 'A:B', typeText: 'Record "Sales Header"', isVar: true }
    ]);
  });

  test('a colon inside a quoted subtype does not move the separator', () => {
    // Passes today; pins that the FIRST UNQUOTED colon is still the
    // `Name : Type` separator after the #184 D2 change.
    const src = [
      'codeunit 50100 "C"',
      '{',
      '    [IntegrationEvent(false, false)]',
      '    procedure OnEvt(Rec: Record "Ns::Weird")',
      '    begin',
      '    end;',
      '}'
    ].join('\n');
    const { publishers } = parseAl(uri, src);
    assert.deepStrictEqual(publishers[0].parameters, [
      { name: 'Rec', typeText: 'Record "Ns::Weird"', isVar: false }
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

suite('al/parser: cross-object attribute binding (#159)', () => {
  test('orphan publisher attribute does not bind to the next object\'s procedure', () => {
    // Object A's [IntegrationEvent] has no procedure beneath it (common
    // mid-edit). The bounded search can reach object B's procedure, but the
    // owner-boundary guard must drop the match rather than emit a phantom
    // publisher attributed to B.
    const src = [
      'codeunit 50100 "A"',
      '{',
      '    [IntegrationEvent(false, false)]',
      '}',
      'codeunit 50101 "B"',
      '{',
      '    procedure OnFromB()',
      '    begin',
      '    end;',
      '}'
    ].join('\n');
    const { publishers } = parseAl(uri, src);
    assert.strictEqual(publishers.length, 0,
      'a dangling attribute in object A must not bind to a procedure in object B');
  });

  test('orphan subscriber attribute does not bind across an object boundary', () => {
    const src = [
      'codeunit 50100 "A"',
      '{',
      '    [EventSubscriber(ObjectType::Codeunit, Codeunit::"Sales-Post", OnAfterPostSalesDoc, \'\', false, false)]',
      '}',
      'codeunit 50101 "B"',
      '{',
      '    procedure HandlerInB()',
      '    begin',
      '    end;',
      '}'
    ].join('\n');
    const { subscribers } = parseAl(uri, src);
    assert.strictEqual(subscribers.length, 0,
      'a dangling subscriber attribute in A must not bind to a procedure in B');
  });

  test('an attribute and its procedure in the SAME object still resolve (no regression)', () => {
    const src = [
      'codeunit 50100 "A"',
      '{',
      '    [IntegrationEvent(false, false)]',
      '    procedure OnInA()',
      '    begin',
      '    end;',
      '}',
      'codeunit 50101 "B"',
      '{',
      '    procedure Unrelated()',
      '    begin',
      '    end;',
      '}'
    ].join('\n');
    const { publishers } = parseAl(uri, src);
    assert.strictEqual(publishers.length, 1);
    assert.strictEqual(publishers[0].eventName, 'OnInA');
    assert.strictEqual(publishers[0].owner.name, 'A');
  });
});

suite('al/parser: preprocessor directives (#182)', () => {
  // Directive text (`#region` / `#endregion` / `#pragma`) is free text, not
  // code, and legally contains apostrophes — `#region Customer's balance` is
  // ordinary BC. Before the fix that apostrophe opened a phantom string state
  // and inverted every subsequent boundary in the file, silently dropping real
  // publishers and fabricating ones out of commented-out code.

  test("an apostrophe in #region text does not drop a real publisher below it", () => {
    // The phantom string opened at `Don't` closes on the Label literal's
    // opening quote, which makes the literal's `/*` read as a real block-comment
    // opener that blanks the rest of the file.
    const src = [
      'codeunit 50100 "T"',
      '{',
      "    #region Don't break",
      '    #endregion',
      "    var L: Label 'x /* y';",
      '',
      '    [IntegrationEvent(false, false)]',
      '    procedure OnAfterFoo()',
      '    begin',
      '    end;',
      '}'
    ].join('\n');
    const { publishers } = parseAl(uri, src);
    assert.strictEqual(publishers.length, 1,
      'the publisher below the directive must survive the apostrophe');
    assert.strictEqual(publishers[0].eventName, 'OnAfterFoo');
    assert.strictEqual(publishers[0].owner.name, 'T');
  });

  test("an apostrophe in #region text does not fabricate a publisher from a block comment", () => {
    // With the scanner believing it is inside a string, the block comment is
    // never blanked and its commented-out attribute binds to the next real
    // procedure.
    const src = [
      'codeunit 50101 "U"',
      '{',
      "    #region Don't index this",
      '    #endregion',
      '    /* [IntegrationEvent(false,false)]',
      '       procedure DeadProc() */',
      '    procedure RealProc()',
      '    begin',
      '    end;',
      '}'
    ].join('\n');
    const { publishers } = parseAl(uri, src);
    assert.strictEqual(publishers.length, 0,
      'a commented-out attribute must stay commented out');
  });

  test("a block comment after an apostrophe directive is stripped even with the attribute on its own line", () => {
    // Hardened variant of the case above: here the attribute is the only thing
    // on its line, so nothing but `stripComments` blanking the block comment can
    // suppress it. Keeps this a #182 regression test independently of the
    // attribute line-anchor rule tracked by #179.
    const src = [
      'codeunit 50101 "U"',
      '{',
      "    #region Don't index this",
      '    #endregion',
      '    /*',
      '    [IntegrationEvent(false, false)]',
      '    procedure DeadProc()',
      '    */',
      '    procedure RealProc()',
      '    begin',
      '    end;',
      '}'
    ].join('\n');
    const { publishers } = parseAl(uri, src);
    assert.strictEqual(publishers.length, 0,
      'the whole block comment must be blanked, attribute included');
  });

  test('the same fixture without the apostrophe is unchanged (control)', () => {
    const src = [
      'codeunit 50101 "U"',
      '{',
      '    #region Dont index this',
      '    #endregion',
      '    /* [IntegrationEvent(false,false)]',
      '       procedure DeadProc() */',
      '    procedure RealProc()',
      '    begin',
      '    end;',
      '}'
    ].join('\n');
    const { publishers } = parseAl(uri, src);
    assert.strictEqual(publishers.length, 0);
  });

  test("directive text containing ' \" // and /* opens no scanner state", () => {
    const src = [
      'codeunit 50100 "Cu"',
      '{',
      '    #region a \' b " c // d /* e',
      '    [IntegrationEvent(false, false)]',
      '    procedure OnAfterBar()',
      '    begin',
      '    end;',
      '    #endregion',
      '}'
    ].join('\n');
    const cleaned = stripComments(src);
    assert.ok(cleaned.includes('[IntegrationEvent(false, false)]'),
      'the attribute below the directive must not be blanked or swallowed');
    assert.ok(cleaned.includes('procedure OnAfterBar()'),
      'the procedure below the directive must not be blanked or swallowed');
    const { publishers } = parseAl(uri, src);
    assert.strictEqual(publishers.length, 1);
    assert.strictEqual(publishers[0].eventName, 'OnAfterBar');
  });

  test('directive text survives verbatim but a trailing // comment is blanked', () => {
    const src = [
      'codeunit 50100 "P"',
      '{',
      '    #pragma implicitwith disable',
      "    #region Customer's balance // Don't index this",
      '',
      '    [IntegrationEvent(false, false)]',
      '    procedure OnP()',
      '    begin',
      '    end;',
      '    #endregion',
      '    #pragma warning restore AA0005',
      '}'
    ].join('\n');
    const cleaned = stripComments(src);
    // Directive text is free text — its apostrophe must not open a string —
    // but a trailing `//` on the line is a comment like any other and has to be
    // blanked, or an `[IntegrationEvent]` written inside it would bind to the
    // procedure below.
    assert.ok(cleaned.includes("#region Customer's balance"),
      'directive text is copied through verbatim, apostrophe included');
    assert.ok(cleaned.includes('#pragma implicitwith disable'));
    assert.ok(!cleaned.includes("Don't index this"),
      'a trailing // comment on a directive line must be blanked like any other');
    const { publishers } = parseAl(uri, src);
    assert.strictEqual(publishers.length, 1,
      'an apostrophe in directive text must not corrupt the scan');
    assert.strictEqual(publishers[0].eventName, 'OnP');
  });

  test('a trailing // comment on a #pragma cannot fabricate a publisher', () => {
    // The directive branch copies directive text verbatim; if it copied the
    // trailing comment too, the attribute regexes would sweep it and bind a
    // phantom publisher to the procedure below — a false positive that does not
    // exist without the directive branch.
    const src = [
      'codeunit 50100 "T"',
      '{',
      '    #pragma warning disable AA0005 // [IntegrationEvent(false, false)]',
      '    procedure NotAnEvent()',
      '    begin',
      '    end;',
      '}'
    ].join('\n');
    const cleaned = stripComments(src);
    assert.ok(cleaned.includes('#pragma warning disable AA0005'),
      'the directive text itself stays verbatim');
    assert.ok(!cleaned.includes('[IntegrationEvent'),
      'the commented-out attribute must not survive into the cleaned text');
    const { publishers } = parseAl(uri, src);
    assert.strictEqual(publishers.length, 0,
      'a commented-out attribute on a directive line must not bind a publisher');
  });

  test('blanking a trailing directive comment preserves length and CRLF terminators', () => {
    // The blanking loop must skip the `\r` of a CRLF pair the way the ordinary
    // line-comment branch does, or every offset after the directive shifts.
    const src = [
      'codeunit 50100 "T"',
      '{',
      "    #pragma warning disable AA0005 // Don't care",
      '    [IntegrationEvent(false, false)]',
      '    procedure OnX()',
      '    begin',
      '    end;',
      '}'
    ].join('\r\n');
    const cleaned = stripComments(src);
    assert.strictEqual(cleaned.length, src.length,
      'every downstream byte offset and jump-to-source Location depends on this');
    for (let i = 0; i < src.length; i++) {
      if (src[i] === '\n' || src[i] === '\r') {
        assert.strictEqual(cleaned[i], src[i],
          `line terminator at offset ${i} must be preserved`);
      }
    }
    assert.ok(!cleaned.includes("Don't care"),
      'the trailing comment is blanked, terminator aside');
    const { publishers } = parseAl(uri, src);
    assert.strictEqual(publishers.length, 1);
    assert.strictEqual(publishers[0].eventName, 'OnX');
  });

  test('a /* on a directive line is blanked to end of line and opens no block comment', () => {
    // `/*` gets the same treatment as `//`: blanked, but only to the newline,
    // so it neither fabricates from its own text nor swallows the real
    // publisher below the way an unbounded block-comment state would.
    const src = [
      'codeunit 50100 "Cu"',
      '{',
      '    #region helpers /* [IntegrationEvent(false, false)]',
      '    procedure NotAnEvent()',
      '    begin',
      '    end;',
      '    #endregion',
      '',
      '    [IntegrationEvent(false, false)]',
      '    procedure OnReal()',
      '    begin',
      '    end;',
      '}'
    ].join('\n');
    const cleaned = stripComments(src);
    assert.ok(cleaned.includes('#region helpers'),
      'directive text before the delimiter survives');
    assert.ok(!cleaned.includes('#region helpers /*'),
      'the comment delimiter and everything after it on the line is blanked');
    const { publishers } = parseAl(uri, src);
    assert.strictEqual(publishers.length, 1,
      'the block comment must not run past the directive line and swallow the file');
    assert.strictEqual(publishers[0].eventName, 'OnReal');
  });

  test('a commented-out object header inside a #region block is still suppressed', () => {
    // The rule is per line, not per region: everything between #region and
    // #endregion is still scanned as code, so a `//`-commented header stays
    // blanked.
    const src = [
      "#region Don't index this",
      '// codeunit 50100 "Fake"',
      '#endregion',
      'codeunit 50101 "Real"',
      '{',
      '    [IntegrationEvent(false, false)]',
      '    procedure OnReal()',
      '    begin',
      '    end;',
      '}'
    ].join('\n');
    const { publishers } = parseAl(uri, src);
    assert.strictEqual(publishers.length, 1);
    assert.strictEqual(publishers[0].owner.name, 'Real',
      'the commented-out header inside the region must not become an object');
  });

  test('a commented-out attribute inside a #region block is still suppressed', () => {
    // The discriminating form of the case above. `objectHeaderRe` is anchored
    // at `^\s*(kind)`, so a commented-out *header* can never match whether it
    // is blanked or not; a commented-out *attribute* can, which is what makes
    // this fixture prove the rule is per line rather than per region.
    const src = [
      'codeunit 50100 "Cu"',
      '{',
      "    #region Don't index this",
      '    // [IntegrationEvent(false, false)]',
      '    procedure NotAnEvent()',
      '    begin',
      '    end;',
      '    #endregion',
      '}'
    ].join('\n');
    const { publishers } = parseAl(uri, src);
    assert.strictEqual(publishers.length, 0,
      'lines inside a #region block are still scanned as code, comments included');
  });

  test('directive text is copied through verbatim, not blanked', () => {
    const src = [
      'codeunit 50100 "T"',
      '{',
      "    #region Don't break",
      '    #endregion',
      '}'
    ].join('\n');
    const cleaned = stripComments(src);
    assert.ok(cleaned.includes("#region Don't break"),
      'blanking the directive would lose information for no benefit');
    assert.ok(cleaned.includes('#endregion'));
  });

  test('stripComments length, \\n and \\r positions are preserved across CRLF directives', () => {
    const src = [
      'codeunit 50100 "T"',
      '{',
      '    /* a block',
      '       comment */',
      "    #region Don't break",
      '    #endregion',
      "    var L: Label 'x /* y';",
      '    // a line comment',
      '',
      '    [IntegrationEvent(false, false)]',
      '    procedure OnAfterFoo()',
      '    begin',
      '    end;',
      '}'
    ].join('\r\n');
    const cleaned = stripComments(src);
    assert.strictEqual(cleaned.length, src.length,
      'every downstream byte offset and jump-to-source Location depends on this');
    for (let i = 0; i < src.length; i++) {
      if (src[i] === '\n' || src[i] === '\r') {
        assert.strictEqual(cleaned[i], src[i],
          `line terminator at offset ${i} must be preserved`);
      }
    }
    const { publishers } = parseAl(uri, src);
    assert.strictEqual(publishers.length, 1);
    assert.strictEqual(publishers[0].eventName, 'OnAfterFoo');
  });

  test('a mid-line # is not a directive', () => {
    // Only a line-leading `#` starts a directive; a `#` inside a string stays
    // inside that string and the string keeps its normal escaping.
    const src = [
      'codeunit 50100 "Cu"',
      '{',
      '    procedure Show()',
      '    begin',
      "        Message('#region x');",
      '    end;',
      '',
      '    [IntegrationEvent(false, false)]',
      '    procedure OnAfterBaz()',
      '    begin',
      '    end;',
      '}'
    ].join('\n');
    const cleaned = stripComments(src);
    assert.ok(cleaned.includes("Message('#region x');"),
      'the string literal must be preserved verbatim, not treated as directive text');
    const { publishers } = parseAl(uri, src);
    assert.strictEqual(publishers.length, 1);
    assert.strictEqual(publishers[0].eventName, 'OnAfterBaz');
  });
});

suite('al/parser: attribute inside a string literal (#179)', () => {
  // `stripComments` copies AL string literals through verbatim by design, so an
  // attribute name written inside one survives into the text the attribute
  // regexes sweep and used to bind forward to the *next* `procedure` keyword.
  // `bindAttributes` now requires the last non-whitespace character before a
  // match, on its own line, to be either nothing or a closing `]`.

  test('an [IntegrationEvent] inside a string does not create a publisher', () => {
    // Pre-fix this yielded publishers ["Next"] — the match sits inside
    // `Unrelated`'s body, so the forward search binds the *following* procedure
    // and #159's cross-object guard can't see it: both live in one object.
    const src = [
      'codeunit 50101 "P"',
      '{',
      '    procedure Unrelated()',
      '    begin',
      "        Error('use [IntegrationEvent] here');",
      '    end;',
      '',
      '    procedure Next()',
      '    begin',
      '    end;',
      '}'
    ].join('\n');
    const { publishers } = parseAl(uri, src);
    assert.strictEqual(publishers.length, 0,
      'an attribute named inside a string literal is not a decorator');
  });

  test('an [EventSubscriber] inside a string does not create a subscriber', () => {
    // No single quotes inside the embedded attribute: `''` is AL's escape for a
    // quote inside a string, and using it would make the fixture's own quoting,
    // rather than the line anchor, the thing under test.
    const src = [
      'codeunit 50102 "S"',
      '{',
      '    procedure Unrelated()',
      '    begin',
      "        Error('use [EventSubscriber(ObjectType::Codeunit, Codeunit::\"Sales-Post\", OnAfterPostSalesDoc, false, false)] here');",
      '    end;',
      '',
      '    procedure Next()',
      '    begin',
      '    end;',
      '}'
    ].join('\n');
    const { subscribers } = parseAl(uri, src);
    assert.strictEqual(subscribers.length, 0,
      'a subscriber attribute named inside a string literal is not a decorator');
  });

  test('a real attribute in the same file still binds', () => {
    // Proves the gate narrowed the sweep rather than disabling it: pre-fix this
    // produced two publishers, both on `OnRealEvent`.
    const src = [
      'codeunit 50103 "M"',
      '{',
      '    procedure Unrelated()',
      '    begin',
      "        Error('use [IntegrationEvent] here');",
      '    end;',
      '',
      '    [IntegrationEvent(false, false)]',
      '    procedure OnRealEvent()',
      '    begin',
      '    end;',
      '}'
    ].join('\n');
    const { publishers } = parseAl(uri, src);
    assert.strictEqual(publishers.length, 1);
    assert.strictEqual(publishers[0].eventName, 'OnRealEvent');
    assert.strictEqual(publishers[0].owner.name, 'M');
  });

  test('stacked attributes on one line still bind', () => {
    // The rule is "last non-whitespace character is nothing or `]`", not
    // "everything before the match is whitespace or `]`" — the prefix here is
    // `[Scope('OnPrem')] `, which contains letters, parens, and quotes.
    const src = [
      'codeunit 50104 "Q"',
      '{',
      "    [Scope('OnPrem')] [IntegrationEvent(false, false)]",
      '    procedure OnAfterFoo()',
      '    begin',
      '    end;',
      '}'
    ].join('\n');
    const { publishers } = parseAl(uri, src);
    assert.strictEqual(publishers.length, 1);
    assert.strictEqual(publishers[0].eventName, 'OnAfterFoo');
  });

  test('an attribute at column 0 still binds', () => {
    // Every other fixture indents; this covers the zero-whitespace half of
    // "with or without leading whitespace".
    const src = [
      'codeunit 50105 "Z"',
      '{',
      '[IntegrationEvent(false, false)]',
      'procedure OnAtColumnZero()',
      'begin',
      'end;',
      '}'
    ].join('\n');
    const { publishers } = parseAl(uri, src);
    assert.strictEqual(publishers.length, 1);
    assert.strictEqual(publishers[0].eventName, 'OnAtColumnZero');
  });

  test('an attribute in #region directive text does not bind', () => {
    // Closes the residual #182 documented and deliberately scoped out: directive
    // text is copied through verbatim, so the attribute reaches the sweep — the
    // last non-whitespace character before it is `n`, from `#region`.
    const src = [
      'codeunit 50106 "R"',
      '{',
      '    #region [IntegrationEvent] helpers',
      '    procedure Helper()',
      '    begin',
      '    end;',
      '    #endregion',
      '}'
    ].join('\n');
    const cleaned = stripComments(src);
    assert.ok(cleaned.includes('#region [IntegrationEvent] helpers'),
      'directive text is still copied through verbatim (#182)');
    const { publishers } = parseAl(uri, src);
    assert.strictEqual(publishers.length, 0,
      'directive text is free text, not a decorator');
  });
});

suite('al/parser: malformed subscriber attribute (#184 D1)', () => {
  // `subscriberAttrRe`'s trailing-arguments span used to be `[\s\S]*?`, which
  // ran forward past an attribute missing its `)]` and consumed the NEXT
  // attribute's terminator. The capture groups came from the malformed
  // attribute while the match ENDED past the valid one, so the malformed
  // target was bound to the valid attribute's procedure and the valid
  // subscriber disappeared. The span now excludes `[`, which every AL
  // attribute opens with.

  test('a malformed [EventSubscriber( does not swallow the next valid subscriber', () => {
    // Both procedures live in ONE object on purpose: split across two objects,
    // #159's owner-boundary guard would drop the bad match for an unrelated
    // reason and this would prove nothing. Pre-fix: one subscriber, Customer /
    // OnAfterInsertEvent, bound to procedure B — and no Vendor at all.
    const src = [
      'codeunit 50100 "Sub Cu"',
      '{',
      '    [EventSubscriber(ObjectType::Table, Database::"Customer", OnAfterInsertEvent, \'\', false, false',
      '    procedure A()',
      '    begin',
      '    end;',
      '',
      '    [EventSubscriber(ObjectType::Table, Database::"Vendor", OnAfterModifyEvent, \'\', false, false)]',
      '    procedure B()',
      '    begin',
      '    end;',
      '}'
    ].join('\n');
    const { subscribers } = parseAl(uri, src);
    assert.strictEqual(subscribers.length, 1,
      'the valid second subscriber must survive the malformed first attribute');
    assert.strictEqual(subscribers[0].target.name, 'Vendor');
    assert.strictEqual(subscribers[0].targetEvent, 'OnAfterModifyEvent');
    assert.ok(!subscribers.some((s) => s.target.name === 'Customer'),
      'the malformed attribute must not be cross-bound to the next procedure');
  });

  test('a malformed attribute with nothing after it yields no subscriber', () => {
    const src = [
      'codeunit 50100 "Sub Cu"',
      '{',
      '    [EventSubscriber(ObjectType::Table, Database::"Customer", OnAfterInsertEvent, \'\', false, false',
      '    procedure A()',
      '    begin',
      '    end;',
      '}'
    ].join('\n');
    const { subscribers } = parseAl(uri, src);
    assert.strictEqual(subscribers.length, 0,
      'an attribute that never closes is not a subscriber declaration');
  });

  test('a genuine multi-line attribute still parses', () => {
    // The new character class excludes only `[`, not newlines, so a wrapped
    // attribute — here split across three lines — is unaffected.
    const src = [
      'codeunit 50203 "Multi Line Sub"',
      '{',
      '    [EventSubscriber(',
      '        ObjectType::Codeunit, Codeunit::\'Sales Post\',',
      '        \'OnAfterPostSalesDoc\', \'\', false, false)]',
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

  test('an ordinary element-name argument still parses', () => {
    // Guards the new tail class against the common 4th argument.
    const src = [
      'codeunit 50100 "Sub Cu"',
      '{',
      '    [EventSubscriber(ObjectType::Table, Database::"Customer", OnAfterInsertEvent, \'No.\', false, false)]',
      '    local procedure HandleIt()',
      '    begin',
      '    end;',
      '}'
    ].join('\n');
    const { subscribers } = parseAl(uri, src);
    assert.strictEqual(subscribers.length, 1);
    assert.strictEqual(subscribers[0].target.name, 'Customer');
    assert.strictEqual(subscribers[0].targetEvent, 'OnAfterInsertEvent');
  });
});

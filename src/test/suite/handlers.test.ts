import * as assert from 'assert';
import * as vscode from 'vscode';
import { handlerUsageKey, indexHandlerUsages, parseHandlers } from '../../al/handlers';

const uri = vscode.Uri.file('/ws/src/SalesTests.Codeunit.al');

function parse(text: string): ReturnType<typeof parseHandlers> {
  return parseHandlers(uri, text);
}

/** Usage count for one handler declaration, the way the CodeLens computes it. */
function usageCount(text: string, handlerName: string): number {
  const { declarations, references } = parse(text);
  const usages = indexHandlerUsages(references);
  const decl = declarations.find(
    (d) => d.name.toLowerCase() === handlerName.toLowerCase()
  );
  assert.ok(decl, `no handler declaration named ${handlerName}`);
  return (usages.get(handlerUsageKey(decl.owner, decl.name)) ?? []).length;
}

suite('al/handlers: declaration parsing', () => {
  test('finds a handler method and records its attribute kind', () => {
    const { declarations } = parse(`
codeunit 50100 "Sales Tests"
{
    SubType = Test;

    [MessageHandler]
    procedure MessageHandler(Msg: Text[1024])
    begin
    end;
}
`);
    assert.strictEqual(declarations.length, 1);
    assert.strictEqual(declarations[0].name, 'MessageHandler');
    assert.strictEqual(declarations[0].handlerKind, 'MessageHandler');
    assert.strictEqual(declarations[0].owner.kind, 'codeunit');
    assert.strictEqual(declarations[0].owner.name, 'Sales Tests');
  });

  test('recognizes all twelve handler attributes', () => {
    const kinds = [
      'MessageHandler', 'ConfirmHandler', 'StrMenuHandler', 'PageHandler',
      'ModalPageHandler', 'ReportHandler', 'RequestPageHandler',
      'SendNotificationHandler', 'HyperLinkHandler', 'RecallNotificationHandler',
      'SessionSettingsHandler', 'FilterPageHandler'
    ];
    const body = kinds
      .map((k, i) => `    [${k}]\n    procedure Handler${i}()\n    begin\n    end;\n`)
      .join('\n');
    const { declarations } = parse(
      `codeunit 50100 "T"\n{\n    SubType = Test;\n\n${body}}\n`
    );
    assert.strictEqual(declarations.length, kinds.length);
    assert.deepStrictEqual(declarations.map((d) => d.handlerKind), kinds);
  });

  test('attribute casing is ignored', () => {
    const { declarations } = parse(`
codeunit 50100 "T"
{
    [messagehandler]
    procedure H()
    begin
    end;
}
`);
    assert.strictEqual(declarations.length, 1);
  });

  test('a non-handler attribute is not treated as a handler', () => {
    const { declarations } = parse(`
codeunit 50100 "T"
{
    [Test]
    procedure NotAHandler()
    begin
    end;
}
`);
    assert.strictEqual(declarations.length, 0);
  });

  test('unwraps a quoted handler procedure name', () => {
    const { declarations } = parse(`
codeunit 50100 "T"
{
    [MessageHandler]
    procedure "My Handler"(Msg: Text[1024])
    begin
    end;
}
`);
    assert.strictEqual(declarations[0].name, 'My Handler');
  });

  test('returns nothing for a file declaring no AL object', () => {
    const { declarations, references } = parse('[MessageHandler]\nprocedure H()\n');
    assert.strictEqual(declarations.length, 0);
    assert.strictEqual(references.length, 0);
  });
});

suite('al/handlers: reference parsing', () => {
  test('captures the test method and its handler names', () => {
    const { references } = parse(`
codeunit 50100 "T"
{
    [Test]
    [HandlerFunctions('MessageHandler,ConfirmYes')]
    procedure TestPostInvoice()
    begin
    end;
}
`);
    assert.strictEqual(references.length, 1);
    assert.strictEqual(references[0].testMethod, 'TestPostInvoice');
    assert.deepStrictEqual(references[0].handlerNames, ['MessageHandler', 'ConfirmYes']);
  });

  test('tolerates whitespace around names and a trailing comma', () => {
    const { references } = parse(`
codeunit 50100 "T"
{
    [HandlerFunctions(' A ,  B ,')]
    procedure T1()
    begin
    end;
}
`);
    assert.deepStrictEqual(references[0].handlerNames, ['A', 'B']);
  });

  test('an empty handler list produces no reference', () => {
    const { references } = parse(`
codeunit 50100 "T"
{
    [HandlerFunctions('')]
    procedure T1()
    begin
    end;
}
`);
    assert.strictEqual(references.length, 0);
  });
});

suite('al/handlers: usage counting', () => {
  const twoTests = `
codeunit 50100 "Sales Tests"
{
    SubType = Test;

    [Test]
    [HandlerFunctions('MessageHandler,ConfirmYes')]
    procedure TestA()
    begin
    end;

    [Test]
    [HandlerFunctions('MessageHandler')]
    procedure TestB()
    begin
    end;

    [MessageHandler]
    procedure MessageHandler(Msg: Text[1024])
    begin
    end;

    [ConfirmHandler]
    procedure ConfirmYes(Q: Text[1024]; var R: Boolean)
    begin
    end;

    [ConfirmHandler]
    procedure ConfirmNo(Q: Text[1024]; var R: Boolean)
    begin
    end;
}
`;

  test('counts every test method naming the handler', () => {
    assert.strictEqual(usageCount(twoTests, 'MessageHandler'), 2);
    assert.strictEqual(usageCount(twoTests, 'ConfirmYes'), 1);
  });

  test('a handler no test names has zero usages (unused / dead test code)', () => {
    assert.strictEqual(usageCount(twoTests, 'ConfirmNo'), 0);
  });

  test('matching is case-insensitive', () => {
    const text = `
codeunit 50100 "T"
{
    [HandlerFunctions('MESSAGEHANDLER')]
    procedure TestA()
    begin
    end;

    [MessageHandler]
    procedure MessageHandler(Msg: Text[1024])
    begin
    end;
}
`;
    assert.strictEqual(usageCount(text, 'MessageHandler'), 1);
  });

  test('a handler is not counted by a reference in a DIFFERENT codeunit', () => {
    // AL resolves handlers within one test codeunit only, so the reference in
    // "Other Tests" must not count toward the handler in "Sales Tests".
    const text = `
codeunit 50100 "Sales Tests"
{
    [MessageHandler]
    procedure MessageHandler(Msg: Text[1024])
    begin
    end;
}

codeunit 50101 "Other Tests"
{
    [Test]
    [HandlerFunctions('MessageHandler')]
    procedure TestA()
    begin
    end;
}
`;
    const { declarations, references } = parse(text);
    const usages = indexHandlerUsages(references);
    const decl = declarations.find((d) => d.owner.name === 'Sales Tests');
    assert.ok(decl);
    assert.strictEqual((usages.get(handlerUsageKey(decl.owner, decl.name)) ?? []).length, 0);
  });

  test('same-named handlers in two codeunits count independently', () => {
    const text = `
codeunit 50100 "A Tests"
{
    [HandlerFunctions('MessageHandler')]
    procedure TestA()
    begin
    end;

    [MessageHandler]
    procedure MessageHandler(Msg: Text[1024])
    begin
    end;
}

codeunit 50101 "B Tests"
{
    [MessageHandler]
    procedure MessageHandler(Msg: Text[1024])
    begin
    end;
}
`;
    const { declarations, references } = parse(text);
    const usages = indexHandlerUsages(references);
    const inA = declarations.find((d) => d.owner.name === 'A Tests');
    const inB = declarations.find((d) => d.owner.name === 'B Tests');
    assert.ok(inA && inB);
    assert.strictEqual((usages.get(handlerUsageKey(inA.owner, inA.name)) ?? []).length, 1);
    assert.strictEqual((usages.get(handlerUsageKey(inB.owner, inB.name)) ?? []).length, 0);
  });

  test('one test method naming a handler twice still counts as one usage', () => {
    // The count is of referencing test *methods*, so a malformed duplicate
    // inside a single attribute must not inflate it — nor put the same test
    // method in the references peek twice.
    const text = `
codeunit 50100 "T"
{
    [HandlerFunctions('H,H')]
    procedure TestA()
    begin
    end;

    [MessageHandler]
    procedure H(Msg: Text[1024])
    begin
    end;
}
`;
    assert.strictEqual(usageCount(text, 'H'), 1);
  });

  test('a duplicate name in one attribute does not duplicate the peek location', () => {
    const { declarations, references } = parse(`
codeunit 50100 "T"
{
    [HandlerFunctions('H, H ,H')]
    procedure TestA()
    begin
    end;

    [MessageHandler]
    procedure H(Msg: Text[1024])
    begin
    end;
}
`);
    const used = indexHandlerUsages(references).get(
      handlerUsageKey(declarations[0].owner, declarations[0].name)
    );
    assert.strictEqual(used?.length, 1);
  });

  test('two distinct test methods naming the same handler both count', () => {
    // Guard the other side of the dedup: folding duplicates must be scoped to
    // a single attribute, not across attributes.
    const text = `
codeunit 50100 "T"
{
    [HandlerFunctions('H')]
    procedure TestA()
    begin
    end;

    [HandlerFunctions('H')]
    procedure TestB()
    begin
    end;

    [MessageHandler]
    procedure H(Msg: Text[1024])
    begin
    end;
}
`;
    assert.strictEqual(usageCount(text, 'H'), 2);
  });
});

suite('al/handlers: comment and boundary handling', () => {
  test('a commented-out handler declaration is ignored', () => {
    const { declarations } = parse(`
codeunit 50100 "T"
{
    // [MessageHandler]
    // procedure Old(Msg: Text[1024])

    [ConfirmHandler]
    procedure Live(Q: Text[1024]; var R: Boolean)
    begin
    end;
}
`);
    assert.strictEqual(declarations.length, 1);
    assert.strictEqual(declarations[0].name, 'Live');
  });

  test('a commented-out [HandlerFunctions] does not count as a usage', () => {
    const text = `
codeunit 50100 "T"
{
    /* [HandlerFunctions('H')]
       procedure OldTest() */

    [MessageHandler]
    procedure H(Msg: Text[1024])
    begin
    end;
}
`;
    assert.strictEqual(usageCount(text, 'H'), 0);
  });

  test('a comment delimiter inside the handler-name string is preserved', () => {
    // `stripComments` copies string literals verbatim, so a `//` inside the
    // quoted list must not blank the rest of the attribute line.
    const { references } = parse(`
codeunit 50100 "T"
{
    [HandlerFunctions('A//B')]
    procedure TestA()
    begin
    end;
}
`);
    assert.deepStrictEqual(references[0].handlerNames, ['A//B']);
  });

  test('a dangling handler attribute does not bind across an object boundary', () => {
    // The bounded procedure search can reach into the next object; the
    // attribute has no procedure of its own and must be dropped, not bound
    // to `Real` in the following codeunit (issue #159's guard).
    const { declarations } = parse(`
codeunit 50100 "First"
{
    [MessageHandler]
}

codeunit 50101 "Second"
{
    procedure Real()
    begin
    end;
}
`);
    assert.strictEqual(declarations.length, 0);
  });
});

import * as vscode from 'vscode';
import type { AlObjectContext } from './parser';
import { bindAttributes, makeObjectContext, stripQuotes } from './parser';
import type { HandlerDeclaration, HandlerReference, ObjectRef } from './types';

/**
 * The AL attributes that mark a method as a UI handler, per the
 * "Create handler methods" documentation. Every one of these is only valid
 * inside a codeunit whose `SubType` is `Test`.
 *
 * Order is irrelevant — the list is joined into one alternation.
 */
const HANDLER_ATTRIBUTE_NAMES: ReadonlyArray<string> = [
  'MessageHandler',
  'ConfirmHandler',
  'StrMenuHandler',
  'PageHandler',
  'ModalPageHandler',
  'ReportHandler',
  'RequestPageHandler',
  'SendNotificationHandler',
  'HyperLinkHandler',
  'RecallNotificationHandler',
  'SessionSettingsHandler',
  'FilterPageHandler'
];

/**
 * Matches a bare handler attribute, e.g. `[MessageHandler]`. The handler
 * attributes take no arguments, but an empty `()` is tolerated for symmetry
 * with the publisher attribute regex.
 */
const handlerDeclAttrRe = new RegExp(
  `\\[\\s*(${HANDLER_ATTRIBUTE_NAMES.join('|')})\\s*(?:\\(\\s*\\))?\\s*\\]`,
  'gi'
);

/**
 * Matches `[HandlerFunctions('A,B')]` and captures the raw name list.
 *
 * The argument is a single-quoted AL string literal. `stripComments` copies
 * string literals through verbatim, so the list survives comment stripping
 * intact — while a `[HandlerFunctions(...)]` sitting inside a comment is
 * blanked and correctly never matches.
 *
 * AL escapes a quote inside a string by doubling it (`''`), but a handler
 * method name is an identifier and can never contain one, so a non-greedy
 * `[^']*` is exact here.
 */
const handlerFunctionsAttrRe = /\[\s*HandlerFunctions\s*\(\s*'([^']*)'\s*\)\s*\]/gi;

/**
 * Key identifying one handler method within its owning object:
 * `(object kind, object name, handler name)`, all case-folded.
 *
 * AL resolves handler references **within a single test codeunit** — "a test
 * method can only call handler methods that are defined in the same test
 * codeunit as the test method" — so the owning object is part of the key and
 * two identically-named handlers in different codeunits never cross-count.
 *
 * The owning app deliberately is *not* part of the key, unlike `matchKey`.
 * Declarations and references are only ever compared within the output of one
 * `parseHandlers` call over one file, so `(kind, name)` already identifies the
 * object uniquely — two objects of the same kind and name in one file is not
 * valid AL. Including `appId` would have added a segment that is always empty.
 *
 * Uses the same U+0001 delimiter as `matchKey` / `subKey`: a C0 control
 * character that cannot legally appear in an AL identifier, so a quoted name
 * containing spaces can't collide two distinct keys.
 */
export function handlerUsageKey(owner: ObjectRef, handlerName: string): string {
  return [owner.kind, owner.name.toLowerCase(), handlerName.toLowerCase()].join('\x01');
}

/**
 * Parse a single AL source file's text into the handler methods it declares
 * and the `[HandlerFunctions]` references that name them.
 *
 * Both sweeps run against `parseAl`'s exact view of the file: comments are
 * stripped first, and each attribute is bound to the procedure beneath it
 * through `bindAttributes`, which drops a dangling attribute rather than
 * letting it bind across an object boundary (issue #159).
 *
 * Deliberately does **not** check that the owning codeunit declares
 * `SubType = Test`. The handler attributes are only legal there, so their
 * presence is already the signal, and parsing object properties would be
 * work with no effect on the result.
 */
export function parseHandlers(
  uri: vscode.Uri,
  text: string
): { declarations: HandlerDeclaration[]; references: HandlerReference[] } {
  const ctx = makeObjectContext(text);
  return ctx ? parseHandlersFrom(uri, ctx) : { declarations: [], references: [] };
}

/**
 * `parseHandlers` against an already-built object context.
 *
 * Exported for the same reason as `parseAlFrom`: the CodeLens provider needs
 * both an event sweep and a handler sweep over one document, and building the
 * context once means `stripComments` / `findObjects` run once per refresh
 * rather than once per parser entry point.
 */
export function parseHandlersFrom(
  uri: vscode.Uri,
  ctx: AlObjectContext
): { declarations: HandlerDeclaration[]; references: HandlerReference[] } {
  const declarations: HandlerDeclaration[] = [];
  for (const b of bindAttributes(ctx, handlerDeclAttrRe)) {
    declarations.push({
      owner: b.owner,
      name: stripQuotes(b.proc.name),
      handlerKind: b.match[1],
      location: new vscode.Location(uri, new vscode.Position(b.proc.line, b.proc.col))
    });
  }

  const references: HandlerReference[] = [];
  for (const b of bindAttributes(ctx, handlerFunctionsAttrRe)) {
    const handlerNames = splitHandlerNames(b.match[1]);
    if (handlerNames.length === 0) {
      continue;
    }
    references.push({
      owner: b.owner,
      testMethod: stripQuotes(b.proc.name),
      handlerNames,
      location: new vscode.Location(uri, new vscode.Position(b.proc.line, b.proc.col))
    });
  }

  return { declarations, references };
}

/**
 * Index references by the handler each one names: one map entry per
 * `(owner, handler name)` pair, holding every **test method** that names it.
 *
 * A single `[HandlerFunctions('A,B')]` contributes to both `A` and `B`.
 * A malformed list naming the same handler twice (`'A,A'`) still contributes
 * that test method **once** — the count is of referencing test methods, which
 * is what the lens claims and what makes the references peek show each test
 * once rather than repeating a row.
 */
export function indexHandlerUsages(
  references: ReadonlyArray<HandlerReference>
): Map<string, HandlerReference[]> {
  const out = new Map<string, HandlerReference[]>();
  for (const r of references) {
    // Fold duplicates within this one attribute before counting.
    const seen = new Set<string>();
    for (const name of r.handlerNames) {
      const key = handlerUsageKey(r.owner, name);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      const list = out.get(key);
      if (list) {
        list.push(r);
      } else {
        out.set(key, [r]);
      }
    }
  }
  return out;
}

/**
 * Split a `[HandlerFunctions('...')]` argument into handler names.
 *
 * Names are comma-separated; surrounding whitespace is tolerated
 * (`'A, B'`) and empty entries from a stray or trailing comma are dropped.
 */
function splitHandlerNames(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

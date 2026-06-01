import * as vscode from 'vscode';
import type { EventKind, ObjectKind, ObjectRef, Parameter, Publisher, Subscriber } from './types';

const OBJECT_KINDS: ReadonlyArray<ObjectKind> = [
  'codeunit', 'table', 'tableextension', 'page', 'pageextension',
  'report', 'reportextension', 'query', 'xmlport', 'enum',
  'enumextension', 'permissionset', 'interface'
];

const OBJECT_KIND_PATTERN = OBJECT_KINDS.join('|');

const objectHeaderRe = new RegExp(
  `^\\s*(${OBJECT_KIND_PATTERN})\\b\\s+(?:(\\d+)\\s+)?(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))`,
  'i'
);

const publisherAttrRe = /\[\s*(IntegrationEvent|BusinessEvent)\s*(?:\([^)]*\))?\s*\]/gi;

const subscriberAttrRe =
  /\[\s*EventSubscriber\s*\(\s*ObjectType::([A-Za-z]+)\s*,\s*[A-Za-z]+::(?:"([^"]+)"|'([^']+)'|([A-Za-z_][A-Za-z0-9_]*))\s*,\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z_][A-Za-z0-9_]*))[\s\S]*?\)\s*\]/gi;

const procedureRe =
  /^[ \t]*(?:local|internal|protected)?[ \t]*procedure[ \t]+("([^"]+)"|[A-Za-z_][A-Za-z0-9_]*)/m;

// Maximum distance (chars) we scan past an event attribute for the
// `procedure` keyword. Valid AL places `procedure` immediately after the
// attribute decorator(s); 2048 covers a generous stack of attributes (e.g.
// [Scope], [Obsolete], [IntegrationEvent]) plus leading whitespace before
// the keyword. Bounding the scan keeps a procedure-less tail O(window)
// instead of O(remaining file), which is what causes the extension-host
// freeze on pathological/adversarial .al (issue #125).
const PROCEDURE_SEARCH_WINDOW = 2048;

/**
 * Parse a single AL source file's text into the publishers and subscribers
 * it declares.
 *
 * Supports both pre-BC22 (`'Codeunit Name'`, `'OnEvent'` — string literals)
 * and BC22+ (`Codeunit::"Name"`, `OnEvent` — bare identifier) subscriber
 * syntaxes. Recognizes `[IntegrationEvent]` and `[BusinessEvent]` attribute
 * forms with any of their parameter shapes.
 *
 * When `appId` is supplied (the workspace `app.json` GUID the file belongs
 * to), it is stamped onto every object's `owner` ref so publishers and
 * subscribers are attributed to their project. Subscriber `target` refs are
 * never stamped — the target lives in some other, possibly unknown app.
 * Callers that omit `appId` (e.g. the `.app` bundled-source pass) keep the
 * previous `owner.appId === undefined` behavior.
 */
export function parseAl(
  uri: vscode.Uri,
  text: string,
  appId?: string
): { publishers: Publisher[]; subscribers: Subscriber[] } {
  const cleaned = stripComments(text);

  const objects = findObjects(cleaned, appId);
  if (objects.length === 0) {
    return { publishers: [], subscribers: [] };
  }

  const ownerForLine = makeOwnerLookup(objects);

  const publishers: Publisher[] = [];
  for (const m of cleaned.matchAll(publisherAttrRe)) {
    const attrEnd = (m.index ?? 0) + m[0].length;
    const proc = findProcedureAfter(cleaned, attrEnd);
    if (!proc) {
      continue;
    }
    // The bounded procedure search (PROCEDURE_SEARCH_WINDOW) can reach into the
    // NEXT object when an attribute is left dangling with no procedure beneath
    // it (common mid-edit). `ownerForLine` returns the same ObjectRef instance
    // for every line in one object, so an identity mismatch means the procedure
    // crossed an object boundary — drop the match rather than bind a phantom
    // publisher to the wrong object (issue #159).
    const procOwner = ownerForLine(proc.line);
    if (procOwner !== ownerForLine(absToLineCol(cleaned, m.index ?? 0).line)) {
      continue;
    }
    const kind: EventKind =
      m[1].toLowerCase() === 'integrationevent' ? 'integration' : 'business';
    publishers.push({
      owner: procOwner,
      eventName: stripQuotes(proc.name),
      kind,
      location: new vscode.Location(uri, new vscode.Position(proc.line, proc.col)),
      parameters: proc.parameters
    });
  }

  const subscribers: Subscriber[] = [];
  for (const m of cleaned.matchAll(subscriberAttrRe)) {
    const attrEnd = (m.index ?? 0) + m[0].length;
    const proc = findProcedureAfter(cleaned, attrEnd);
    if (!proc) {
      continue;
    }
    const targetKind = objectKindFromString(m[1]);
    const targetName = m[2] ?? m[3] ?? m[4];
    const targetEvent = m[5] ?? m[6] ?? m[7];
    if (!targetKind || !targetName || !targetEvent) {
      continue;
    }
    // Same cross-object guard as the publisher loop (issue #159): a dangling
    // [EventSubscriber] must not bind to the next object's procedure.
    const procOwner = ownerForLine(proc.line);
    if (procOwner !== ownerForLine(absToLineCol(cleaned, m.index ?? 0).line)) {
      continue;
    }
    subscribers.push({
      owner: procOwner,
      target: { kind: targetKind, name: targetName },
      targetEvent,
      location: new vscode.Location(uri, new vscode.Position(proc.line, proc.col)),
      resolved: false
    });
  }

  return { publishers, subscribers };
}

interface ObjectBoundary {
  readonly ref: ObjectRef;
  readonly startLine: number;
}

function findObjects(cleaned: string, appId?: string): ObjectBoundary[] {
  const out: ObjectBoundary[] = [];
  const lines = cleaned.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = objectHeaderRe.exec(lines[i]);
    if (!m) {
      continue;
    }
    const kind = objectKindFromString(m[1]);
    if (!kind) {
      continue;
    }
    const name = m[3] ?? m[4] ?? '';
    if (!name) {
      continue;
    }
    out.push({
      ref: {
        kind,
        id: m[2] ? parseInt(m[2], 10) : undefined,
        name,
        appId
      },
      startLine: i
    });
  }
  return out;
}

function makeOwnerLookup(objects: ReadonlyArray<ObjectBoundary>): (line: number) => ObjectRef {
  return (line: number): ObjectRef => {
    let owner = objects[0].ref;
    for (const o of objects) {
      if (o.startLine <= line) {
        owner = o.ref;
      } else {
        break;
      }
    }
    return owner;
  };
}

interface ProcedureSite {
  readonly line: number;
  readonly col: number;
  readonly name: string;
  readonly parameters: ReadonlyArray<Parameter>;
}

function findProcedureAfter(text: string, fromIdx: number): ProcedureSite | undefined {
  // Bound the keyword search to a fixed window so a procedure-less tail is
  // O(window) instead of O(remaining file) — see PROCEDURE_SEARCH_WINDOW.
  // The parameter list below is still read against the full `text`, so a
  // long multi-line signature that extends past the window parses in full.
  const rest = text.slice(fromIdx, fromIdx + PROCEDURE_SEARCH_WINDOW);
  const m = procedureRe.exec(rest);
  if (!m) {
    return undefined;
  }
  const absMatchStart = fromIdx + (m.index ?? 0);

  const nameOffsetInMatch = m[0].search(/[A-Za-z_"]/);
  const procKwIdx = m[0].toLowerCase().indexOf('procedure');
  const afterKw = m[0].slice(procKwIdx + 'procedure'.length);
  const wsLen = afterKw.length - afterKw.trimStart().length;
  const nameStartInMatch = nameOffsetInMatch >= 0
    ? procKwIdx + 'procedure'.length + wsLen
    : 0;
  const nameAbs = absMatchStart + nameStartInMatch;
  const { line, col } = absToLineCol(text, nameAbs);

  // Locate the parameter list `(...)` immediately after the procedure name
  // and parse it. The name regex matched a single token, so the open paren
  // is the next non-whitespace character starting from the end of m[0].
  const afterMatchAbs = absMatchStart + m[0].length;
  const parameters = parseParameterListAt(text, afterMatchAbs);

  return { line, col, name: m[1], parameters };
}

/**
 * Starting at `fromIdx`, skip whitespace, expect `(`, then collect the
 * balanced contents through the matching `)` and parse them into a parameter
 * list. Returns `[]` for `()`, and `[]` (as a soft fallback) if no opening
 * paren is found within a few characters — pathological AL that lacks a
 * parameter list at all shouldn't crash parsing.
 */
function parseParameterListAt(text: string, fromIdx: number): ReadonlyArray<Parameter> {
  let i = fromIdx;
  while (i < text.length && /\s/.test(text[i])) {
    i++;
  }
  if (text[i] !== '(') {
    return [];
  }
  // Scan forward to the matching close paren, ignoring nested parens that
  // can appear inside type expressions like `Dictionary of [Code[20], Text]`.
  // A quoted AL identifier (`"Weird (Name)"` as a parameter name or quoted
  // Record subtype) can legally contain parens, so spans inside `"…"` are
  // skipped — their structural characters are part of the name, not the
  // list structure. (AL quoted identifiers have no embedded-quote escape, so
  // a single toggle on `"` suffices.)
  let depth = 0;
  let inQuote = false;
  const start = i + 1;
  let end = -1;
  for (let j = i; j < text.length; j++) {
    const ch = text[j];
    if (ch === '"') {
      inQuote = !inQuote;
    } else if (inQuote) {
      continue;
    } else if (ch === '(') {
      depth++;
    } else if (ch === ')') {
      depth--;
      if (depth === 0) {
        end = j;
        break;
      }
    }
  }
  if (end < 0) {
    return [];
  }
  const inner = text.slice(start, end).trim();
  if (!inner) {
    return [];
  }
  return splitParameterList(inner)
    .map(parseOneParameter)
    .filter((p): p is Parameter => p !== undefined);
}

/**
 * Split a parameter list body by `;` at the **top level only** — `;` inside
 * brackets (e.g. `Dictionary of [Code[20]; Text]`) is part of a type
 * expression and must not be treated as a separator. Spans inside a quoted
 * identifier (`"Weird ; Name"`) are skipped too, so a `;`/`[`/`]`/`(`/`)`
 * inside a quoted name or subtype is never mistaken for list structure.
 */
function splitParameterList(inner: string): string[] {
  const parts: string[] = [];
  let depthBracket = 0;
  let depthParen = 0;
  let inQuote = false;
  let last = 0;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === '"') {
      inQuote = !inQuote;
    } else if (inQuote) {
      continue;
    } else if (ch === '[') {
      depthBracket++;
    } else if (ch === ']') {
      depthBracket--;
    } else if (ch === '(') {
      depthParen++;
    } else if (ch === ')') {
      depthParen--;
    } else if (ch === ';' && depthBracket === 0 && depthParen === 0) {
      parts.push(inner.slice(last, i));
      last = i + 1;
    }
  }
  parts.push(inner.slice(last));
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

/**
 * Parse one AL parameter declaration of the form `[var ] Name : Type`. The
 * `Type` portion is preserved verbatim (whitespace trimmed) — collapsing it
 * into a richer model isn't necessary for display.
 */
function parseOneParameter(raw: string): Parameter | undefined {
  let s = raw.trim();
  let isVar = false;
  const varMatch = /^var\s+/i.exec(s);
  if (varMatch) {
    isVar = true;
    s = s.slice(varMatch[0].length);
  }
  const colonIdx = s.indexOf(':');
  if (colonIdx < 0) {
    return undefined;
  }
  const nameRaw = s.slice(0, colonIdx).trim();
  const typeText = s.slice(colonIdx + 1).trim();
  if (!nameRaw || !typeText) {
    return undefined;
  }
  return { name: stripQuotes(nameRaw), typeText, isVar };
}

function absToLineCol(text: string, idx: number): { line: number; col: number } {
  let line = 0;
  let lineStart = 0;
  for (let i = 0; i < idx && i < text.length; i++) {
    if (text[i] === '\n') {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, col: idx - lineStart };
}

function objectKindFromString(s: string): ObjectKind | undefined {
  const lower = s.toLowerCase();
  return (OBJECT_KINDS as ReadonlyArray<string>).includes(lower)
    ? (lower as ObjectKind)
    : undefined;
}

function stripQuotes(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

/**
 * Replace comment content with spaces (preserving newlines and string offsets),
 * so downstream regex matches don't fire on text inside line or block comments.
 *
 * Exported so callers that run their own regex sweeps over AL source (e.g. the
 * indexer's trigger-owner collection) match `parseAl`'s view of the file —
 * commented-out object headers must not be treated as real declarations.
 *
 * Implemented as a single forward character scan with four exclusive states
 * (single-quote string, double-quote quoted identifier, line comment, block
 * comment). A `//` or `/*` is only a comment opener while in code state, so
 * comment delimiters that appear *inside* an AL string literal (`'…'`) or
 * quoted identifier (`"…"`) are left verbatim rather than blanking real code.
 * AL's doubled-quote escapes (`''` inside `'…'`, `""` inside `"…"`) are
 * honored so an escaped quote doesn't prematurely close the span. The result
 * is the same length as the input: only non-newline comment content is blanked
 * to `' '`; every `\n`/`\r` is preserved, so all downstream line/column and
 * byte offsets are unchanged.
 */
export function stripComments(text: string): string {
  const out = text.split('');
  const n = text.length;
  let i = 0;
  while (i < n) {
    const ch = text[i];
    // 1. Single-quote string: spans lines; only a lone `'` closes it.
    if (ch === "'") {
      out[i] = ch;
      i++;
      while (i < n) {
        if (text[i] === "'") {
          if (text[i + 1] === "'") {
            // Doubled-quote escape — stays inside the string.
            out[i] = text[i];
            out[i + 1] = text[i + 1];
            i += 2;
            continue;
          }
          out[i] = text[i]; // closing quote
          i++;
          break;
        }
        out[i] = text[i];
        i++;
      }
      continue;
    }
    // 2. Double-quote quoted identifier: same shape as (1) with `"`.
    if (ch === '"') {
      out[i] = ch;
      i++;
      while (i < n) {
        if (text[i] === '"') {
          if (text[i + 1] === '"') {
            out[i] = text[i];
            out[i + 1] = text[i + 1];
            i += 2;
            continue;
          }
          out[i] = text[i];
          i++;
          break;
        }
        out[i] = text[i];
        i++;
      }
      continue;
    }
    // 3. Line comment: blank through to (but not including) the newline.
    if (ch === '/' && text[i + 1] === '/') {
      out[i] = ' ';
      out[i + 1] = ' ';
      i += 2;
      while (i < n && text[i] !== '\n') {
        out[i] = text[i] === '\r' ? '\r' : ' ';
        i++;
      }
      continue;
    }
    // 4. Block comment: blank through the first real `*/`; preserve newlines.
    if (ch === '/' && text[i + 1] === '*') {
      out[i] = ' ';
      out[i + 1] = ' ';
      i += 2;
      while (i < n) {
        if (text[i] === '*' && text[i + 1] === '/') {
          out[i] = ' ';
          out[i + 1] = ' ';
          i += 2;
          break;
        }
        out[i] = text[i] === '\n' || text[i] === '\r' ? text[i] : ' ';
        i++;
      }
      continue;
    }
    // 5. Code: copy through verbatim.
    out[i] = ch;
    i++;
  }
  return out.join('');
}
